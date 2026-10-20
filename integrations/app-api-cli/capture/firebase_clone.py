"""Preserve the original public Firebase Android client identity in a test clone.

Only Firebase Installations' two identification headers are adjusted. Account
credentials, integrity checks and the original installed package are untouched.
"""
import os
from pathlib import Path
import re
import subprocess


def patch_firebase(root, original_apk, package, signer):
    result = subprocess.run([str(signer),'verify','--print-certs',str(original_apk)],
                            capture_output=True,text=True,timeout=30,
                            env={**os.environ,'JAVA_HOME':'/opt/homebrew/opt/openjdk@17'})
    if result.returncode: raise RuntimeError('Could not inspect original public signing certificate')
    cert = re.search(r'Signer #1 certificate SHA-1 digest: ([a-f0-9]+)',result.stdout)
    if not cert: raise RuntimeError('Original SHA-1 not found')
    touched=[]
    for path in root.glob('smali*/**/*.smali'):
        text=path.read_text()
        if '"X-Android-Package"' not in text or '"X-Android-Cert"' not in text: continue
        if 'firebaseinstallations.googleapis.com' not in text: continue
        for header,value in [('X-Android-Package',package),('X-Android-Cert',cert.group(1).upper())]:
            start=text.index('"'+header+'"')
            match=re.search(r'invoke-virtual \{([^}]+)\}, Ljava/net/(?:Http)?URLConnection;->addRequestProperty\(Ljava/lang/String;Ljava/lang/String;\)V',text[start:])
            if not match: raise RuntimeError('Unsupported Firebase header setter')
            reg=match.group(1).split(',')[-1].strip()
            index=start+match.start()
            insertion=f'const-string {reg}, "{value}"\n\n    '
            if text[max(0,index-len(insertion)):index] != insertion:
                text=text[:index]+insertion+text[index:]
        path.write_text(text)
        touched.append(path.name)
    if not touched: raise RuntimeError('Firebase header class not found')
    return touched
