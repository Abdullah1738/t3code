"""Bounded clone launch diagnostics with strictly selected, non-secret output."""
import argparse
import json
import re
import subprocess
from phone_guard import check, SERIAL


def summarize(log, package):
    pids=set(re.findall(r'Start proc (\d+):'+re.escape(package),log))
    own=[l for l in log.splitlines() if any(re.search(r'\(\s*'+p+r'\)',l) for p in pids)]
    joined='\n'.join(own)
    summary={'package':package,'new_processes':len(pids),
             'firebase_android_app_blocked':'API_KEY_ANDROID_APP_BLOCKED' in joined,
             'fis_auth_error':'FIS_AUTH_ERROR' in joined,
             'fatal_exception':'FATAL EXCEPTION' in joined,
             'socket_hook_ready':'socket hook ready' in joined}
    summary['exceptions']=sorted(set(re.findall(r'\b(?:[a-zA-Z0-9_$]+\.)+[A-Za-z0-9_$]*(?:Exception|Error)\b',joined)))[:20]
    summary['own_activity_starts']=sorted(set(re.findall(re.escape(package)+r'/([a-zA-Z0-9_.$]+)',log)))[:20]
    # Android's activity errors can explain missing clone routes. Never return
    # arbitrary error messages, Intent extras, Firebase options or API URLs.
    summary['activity_not_found']='ActivityNotFoundException' in joined
    return summary


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('app',choices=['careem','talabat'])
    args=parser.parse_args()
    package='com.'+args.app+'.capture'
    activity='com.careem.superapp.OnboardingActivityDefaultIcon' if args.app=='careem' else 'com.talabat.MainActivityDefault'
    check()
    subprocess.run(['adb','-s',SERIAL,'shell','am','force-stop',package],capture_output=True,timeout=15)
    check()
    p=subprocess.Popen(['adb','-s',SERIAL,'logcat','-T','1','-v','brief'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
    try:
        check()
        subprocess.run(['adb','-s',SERIAL,'shell','am','start','-a','android.intent.action.MAIN','-c','android.intent.category.LAUNCHER','-n',package+'/'+activity],capture_output=True,timeout=15)
        try: out,_=p.communicate(timeout=12)
        except subprocess.TimeoutExpired:
            p.terminate();out,_=p.communicate(timeout=5)
        print(json.dumps(summarize(out,package)))
    finally:
        if p.poll() is None: p.terminate();p.wait(timeout=5)


if __name__ == '__main__': main()
