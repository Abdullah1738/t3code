"""Build a separate Careem diagnostic APK offline; preserve the installed original."""
import json
from pathlib import Path
import shutil
import xml.etree.ElementTree as ET
from prepare_talabat_clone import PATCH, RECON, JAVA, BUILD, A, run
from firebase_clone import patch_firebase

PACKAGE = 'com.careem.capture'
ROOT = RECON/'careem/clone'


def prepare():
    tree = ET.parse(ROOT/'AndroidManifest.xml')
    manifest = tree.getroot()
    manifest.set('package', PACKAGE)
    manifest.attrib.pop(A+'requiredSplitTypes', None)
    manifest.attrib.pop(A+'splitTypes', None)
    app = manifest.find('application')
    app.set(A+'label', 'Careem Capture')
    app.set(A+'debuggable', 'true')
    app.set(A+'extractNativeLibs', 'true')
    for node in manifest.iter():
        if node.tag == 'activity-alias' and 'OnboardingActivity' in node.get(A+'name',''):
            node.set(A+'label', 'Careem Capture')
        if A+'authorities' in node.attrib:
            node.set(A+'authorities', node.get(A+'authorities').replace('com.careem.acma.', PACKAGE+'.'))
        if node.tag in ('permission', 'uses-permission'):
            node.set(A+'name', node.get(A+'name', '').replace('com.careem.acma.', PACKAGE+'.'))
    for parent in manifest.iter():
        for node in list(parent):
            if node.tag == 'intent-filter' and any(c.get(A+'name') == 'android.intent.category.BROWSABLE' for c in node):
                parent.remove(node)
    # The app's own navigation resolves careem:// intents scoped to its package.
    # Keep that internal route without advertising a browser URL handler.
    nav = next(n for n in app if n.get(A+'name') == 'com.careem.superapp.core.lib.navigation.NavActivity')
    if not nav.findall('intent-filter'):
        route = ET.SubElement(nav, 'intent-filter')
        ET.SubElement(route,'data',{A+'scheme':'careem',A+'host':'*'})
        ET.SubElement(route,'action',{A+'name':'android.intent.action.VIEW'})
        ET.SubElement(route,'category',{A+'name':'android.intent.category.DEFAULT'})
    tree.write(ROOT/'AndroidManifest.xml', encoding='utf-8', xml_declaration=True)
    raw = ROOT/'res/raw'
    raw.mkdir(exist_ok=True)
    shutil.copyfile(RECON/'mitmconf/mitmproxy-ca-cert.pem', raw/'capture_ca.pem')
    (ROOT/'res/xml/network_security_config.xml').write_text('''<network-security-config>
  <base-config cleartextTrafficPermitted="false"><trust-anchors><certificates src="system"/></trust-anchors></base-config>
  <domain-config>
    <domain includeSubdomains="true">careem.com</domain>
    <domain includeSubdomains="true">careemapis.com</domain>
    <domain includeSubdomains="true">careemdash.com</domain>
    <domain includeSubdomains="true">careem-engineering.com</domain>
    <trust-anchors><certificates src="system"/><certificates src="@raw/capture_ca" overridePins="true"/></trust-anchors>
  </domain-config>
</network-security-config>''')
    for d in (RECON/'careem/dex').glob('smali*'):
        if not (ROOT/d.name).exists(): shutil.copytree(d, ROOT/d.name)
    for d in ROOT.glob('classes*.dex'): d.unlink()
    patch_firebase(ROOT, RECON/'apk/careem/base.apk', 'com.careem.acma', BUILD/'apksigner')
    # Remove temporary stack instrumentation from the completed investigation.
    for relative in ('smali_classes6/dbm.smali', 'smali_classes7/fc3.smali'):
        p = ROOT/relative
        content = p.read_text().replace('    invoke-static {}, Ljava/lang/Thread;->dumpStack()V\n\n', '')
        content = content.replace('    new-instance v0, Ljava/lang/Exception;\n'
                                  '    invoke-direct {v0}, Ljava/lang/Exception;-><init>()V\n'
                                  '    invoke-virtual {v0}, Ljava/lang/Throwable;->printStackTrace()V\n\n', '')
        p.write_text(content)
    # The clone is deliberately patched/debuggable. Its local integrity KILL action
    # otherwise cancels WorkManager and SIGKILLs itself on every launch (confirmed
    # by exit-info and dbm's runtime stack). Keep server login/authentication intact.
    target = ROOT/'smali_classes6/xx1.smali'
    text = target.read_text()
    start = text.index('.method public execute()V')
    end = text.index('.end method', start)+len('.end method')
    target.write_text(text[:start]+'.method public execute()V\n    .locals 0\n    return-void\n.end method'+text[end:])
    target = ROOT/'smali_classes2/com/careem/superapp/SuperApp.smali'
    text = target.read_text()
    start = text.index('.method public final attachBaseContext(')
    end = text.index('.end method', start)
    method = text[start:end]
    if 'loadLibrary' not in method:
        method = method.replace('.locals 0', '.locals 1').replace('    return-void', '''    const-string v0, "capture"
    invoke-static {v0}, Ljava/lang/System;->loadLibrary(Ljava/lang/String;)V
    return-void''')
        target.write_text(text[:start]+method+text[end:])
    lib = ROOT/'lib/arm64-v8a'
    shutil.copyfile(PATCH/'libcapture.so', lib/'libcapture.so')
    (lib/'libcapture.config.so').write_text(json.dumps({'interaction': {'type':'script','path':'libcapture.script.so'}, 'teardown':'full'}))
    script = '''const DEBUG_MODE = false;
const PROXY_HOST = '127.0.0.1';
const PROXY_PORT = 18091;
const PROXY_SUPPORTS_SOCKS5 = true;
const BLOCK_HTTP3 = true;
const IGNORED_NON_HTTP_PORTS = [53, 18091];
const accessFile = new NativeFunction(Module.getGlobalExportByName('access'), 'int', ['pointer','int']);
const marker = Memory.allocUtf8String('/data/user/0/com.careem.capture/files/capture-enabled');
const log = new NativeFunction(Module.getGlobalExportByName('__android_log_write'), 'int', ['int','pointer','pointer']);
const tag = Memory.allocUtf8String('CareemCapture');
for (const name of ['log','error','warn','debug']) console[name] = () => {};
log(4, tag, Memory.allocUtf8String('socket hook ready'));
'''
    connect = (RECON/'fiu/native-connect-hook.js').read_text().replace('onEnter(args) {', "onEnter(args) {\n            if (accessFile(marker, 0) !== 0) { this.state = 'ignored'; return; }")
    (lib/'libcapture.script.so').write_text(script+connect)
    work = RECON/'careem'
    run([JAVA,'-jar',PATCH/'apktool.jar','b',ROOT,'-o',work/'unsigned.apk'])
    run([BUILD/'zipalign','-f','-p','4',work/'unsigned.apk',work/'aligned.apk'])
    run([BUILD/'apksigner','sign','--ks',Path.home()/'.android/debug.keystore','--ks-pass','pass:android','--out',work/'careem-capture.apk',work/'aligned.apk'])
    run([BUILD/'apksigner','verify',work/'careem-capture.apk'])
    print(json.dumps({'built':str(work/'careem-capture.apk'),'package':PACKAGE,'installed':False}))


if __name__ == '__main__': prepare()
