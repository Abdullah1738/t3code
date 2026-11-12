"""Only fabricated selectors; never import incident data into these fixtures."""
import json

NEEDLE=b'fakecredentialquartz98765'


def variants():
    text=NEEDLE.decode()
    lower=''.join('\\u%04x'%ord(c) for c in text)
    upper=''.join('\\u%04X'%ord(c) for c in text)
    mixed=''.join(c if i%3==0 else ('\\u%04x'%ord(c) if i%2 else '\\u%04X'%ord(c)) for i,c in enumerate(text))
    forms={label:'{"value":"'+value+'"}' for label,value in
           (('literal',text),('unicode-lower',lower),('unicode-upper',upper),('partial-mixed',mixed))}
    forms.update({label+'-stringified':json.dumps(value) for label,value in tuple(forms.items())})
    forms['nested-stringified']=json.dumps(json.dumps(forms['unicode-lower']))
    forms['nested-unicode']='{"value":"'+''.join('\\u%04x'%ord(c) for c in forms['unicode-lower'])+'"}'
    return forms


def assert_single_snapshot_refused(test,repo,path):
    from unittest.mock import patch
    import redact
    import redact_backups
    redact_backups.restic(repo,'init');redact_backups.restic(repo,'backup',str(path))
    original=redact_backups.restic
    before=original(repo,'snapshots','--json',json_output=True)
    with patch('redact_backups.restic',wraps=original) as calls,test.assertRaises(redact.RedactionError):
        redact_backups.rewrite_repo(repo,None,NEEDLE,set(),dry_run=False)
    test.assertFalse(any(call.args[1] in ('rewrite','prune') for call in calls.call_args_list))
    test.assertEqual(original(repo,'snapshots','--json',json_output=True),before)
    test.assertEqual(original(repo,'list','locks').splitlines(),[])
