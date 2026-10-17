"""Build a separate root-free diagnostic APK; never installs or touches the phone."""
import argparse
import json
import os
from pathlib import Path
import shutil
import ssl
import subprocess
import xml.etree.ElementTree as ET
from firebase_clone import patch_firebase

PATCH = Path(os.environ['TMPDIR'])/'opencode/recon/patch'
RECON = PATCH.parent
JAVA = '/opt/homebrew/opt/openjdk@17/bin/java'
BUILD = Path('/opt/homebrew/share/android-commandlinetools/build-tools/36.0.0')
PACKAGE = 'com.talabat.capture'
A = '{http://schemas.android.com/apk/res/android}'
ET.register_namespace('android', A[1:-1])


def run(args):
    result = subprocess.run([str(a) for a in args], capture_output=True, text=True,
                            timeout=180, env={**os.environ, 'JAVA_HOME': '/opt/homebrew/opt/openjdk@17'})
    if result.returncode:
        raise RuntimeError(result.stdout[-2000:] + result.stderr[-2000:])


def prepare():
    root = PATCH/'clone'
    tree = ET.parse(root/'AndroidManifest.xml')
    manifest = tree.getroot()
    manifest.set('package', PACKAGE)
    manifest.attrib.pop(A+'requiredSplitTypes', None)
    manifest.attrib.pop(A+'splitTypes', None)
    app = manifest.find('application')
    app.set(A+'name', 'com.talabat.capture.CaptureApplication')
    app.set(A+'label', 'Talabat Capture')
    app.set(A+'debuggable', 'true')
    app.set(A+'extractNativeLibs', 'true')
    for node in manifest.iter():
        if A+'authorities' in node.attrib:
            authority = node.get(A+'authorities')
            if not authority.startswith(PACKAGE+'.'):
                node.set(A+'authorities', authority.replace('com.talabat.', PACKAGE+'.'))
        if node.tag in ('permission', 'uses-permission'):
            name = node.get(A+'name', '')
            if name.startswith('com.talabat.') and not name.startswith(PACKAGE+'.'):
                node.set(A+'name', name.replace('com.talabat.', PACKAGE+'.', 1))
    # Keep the clone out of URL routing.
    for parent in manifest.iter():
        for node in list(parent):
            if node.tag == 'intent-filter' and any(c.get(A+'name') == 'android.intent.category.BROWSABLE' for c in node):
                parent.remove(node)
    for node in list(app):
        if node.tag == 'meta-data' and node.get(A+'name', '').startswith('com.android.vending.'):
            app.remove(node)
    tree.write(root/'AndroidManifest.xml', encoding='utf-8', xml_declaration=True)

    raw = root/'res/raw'
    raw.mkdir(exist_ok=True)
    shutil.copyfile(RECON/'mitmconf/mitmproxy-ca-cert.pem', raw/'capture_ca.pem')
    (root/'res/xml/network_security_config.xml').write_text('''<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="false">
    <trust-anchors><certificates src="system"/></trust-anchors>
  </base-config>
  <domain-config>
    <domain includeSubdomains="true">talabat.com</domain>
    <trust-anchors><certificates src="system"/><certificates src="@raw/capture_ca" overridePins="true"/></trust-anchors>
  </domain-config>
  <domain-config cleartextTrafficPermitted="true"><domain>localhost</domain></domain-config>
</network-security-config>
''')
    for d in (PATCH/'dex').glob('smali*'):
        if not (root/d.name).exists(): shutil.copytree(d, root/d.name)
    for d in root.glob('classes*.dex'): d.unlink()
    patch_firebase(root, RECON/'apk/talabat/base.apk', 'com.talabat', BUILD/'apksigner')
    target = root/'smali/com/talabat/capture/CaptureApplication.smali'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text('''.class public Lcom/talabat/capture/CaptureApplication;
.super Lcom/talabat/TalabatApplication;

.method public constructor <init>()V
    .locals 0
    invoke-direct {p0}, Lcom/talabat/TalabatApplication;-><init>()V
    return-void
.end method

.method protected attachBaseContext(Landroid/content/Context;)V
    .locals 1
    invoke-super {p0, p1}, Lcom/talabat/TalabatApplication;->attachBaseContext(Landroid/content/Context;)V
    const-string v0, "capture"
    invoke-static {v0}, Ljava/lang/System;->loadLibrary(Ljava/lang/String;)V
    return-void
.end method
''')
    lib = root/'lib/arm64-v8a'
    shutil.copyfile(PATCH/'libcapture.so', lib/'libcapture.so')
    (lib/'libcapture.config.so').write_text(json.dumps({
        'interaction': {'type': 'script', 'path': 'libcapture.script.so'},
        'teardown': 'full',
    }))
    der = ssl.PEM_cert_to_DER_cert((RECON/'mitmconf/mitmproxy-ca-cert.pem').read_text())
    script = 'const DEBUG_MODE = false;\nconst CERT_DER = new Uint8Array('+json.dumps(list(der))+');\n'
    script += '''const log = new NativeFunction(Module.getGlobalExportByName('__android_log_write'), 'int', ['int','pointer','pointer']);
const logTag = Memory.allocUtf8String('CaptureDiagnostic');
for (const name of ['log','error','warn','debug']) {
    console[name] = (...args) => log(4, logTag, Memory.allocUtf8String(args.map(String).join(' ')));
}
console.log('capture script loaded');
const PROXY_HOST = '127.0.0.1';
const PROXY_PORT = 18090;
const PROXY_SUPPORTS_SOCKS5 = true;
const BLOCK_HTTP3 = true;
const IGNORED_NON_HTTP_PORTS = [53, 18090];
const accessFile = new NativeFunction(Module.getGlobalExportByName('access'), 'int', ['pointer','int']);
const marker = Memory.allocUtf8String('/data/user/0/com.talabat.capture/files/capture-enabled');
let seenConnections = 0;
setInterval(() => console.log('capture enabled=' + (accessFile(marker, 0) === 0) + ' connections=' + seenConnections), 10000);
'''
    connect = (RECON/'fiu/native-connect-hook.js').read_text()
    connect = connect.replace('onEnter(args) {', "onEnter(args) {\n            seenConnections++;\n            if (accessFile(marker, 0) !== 0) { this.state = 'ignored'; return; }")
    script += connect
    script += '''const observers = [];
function waitForModule(name, callback) {
    observers.push(Process.attachModuleObserver({onAdded(module) {
        if (module.name === name) callback(module);
    }}));
}
'''
    flutter = (RECON/'fiu/android/android-disable-flutter-certificate-pinning.js').read_text()
    flutter = flutter.replace('if (retval.toInt32() === 1) return;',
        "if (accessFile(marker, 0) === 0) { retval.replace(1); return; }\n                    if (retval.toInt32() === 1) return;")
    script += flutter
    (lib/'libcapture.script.so').write_text(script)
    run([JAVA, '-jar', PATCH/'apktool.jar', 'b', root, '-o', PATCH/'clone-unsigned.apk'])
    run([BUILD/'zipalign', '-f', '-p', '4', PATCH/'clone-unsigned.apk', PATCH/'clone-aligned.apk'])
    # Existing public-purpose Android debug signer; no account credential involved.
    run([BUILD/'apksigner', 'sign', '--ks', Path.home()/'.android/debug.keystore',
         '--ks-pass', 'pass:android', '--out', PATCH/'talabat-capture.apk', PATCH/'clone-aligned.apk'])
    run([BUILD/'apksigner', 'verify', PATCH/'talabat-capture.apk'])
    print(json.dumps({'built': str(PATCH/'talabat-capture.apk'), 'package': PACKAGE,
                      'original_untouched': True, 'installed': False}))


if __name__ == '__main__':
    argparse.ArgumentParser(description=__doc__).parse_args()
    prepare()
