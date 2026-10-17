import base64
import copy
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
import urllib.error

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import careem_auth as auth
import careem_search as search


def token(kind='GUEST', extra=0):
    body = base64.urlsafe_b64encode(json.dumps({'kind': kind, 'exp': int(time.time()) + 3600 + extra}).encode()).decode().rstrip('=')
    return 'header.' + body + '.signature'


def saved():
    return {'templates': {'GET appengine.careemapis.com/v1/page/quik-search-listing': {
        'url': 'https://appengine.careemapis.com/v1/page/quik-search-listing?query=milk',
        'headers': {'authorization': 'Bearer ' + token()}}},
        'refresh_auth': {'authorization': 'Basic test'},
        'refresh_bootstrap': {'access_token': token(), 'refresh_token': 'old'}}


class RenewalTests(unittest.TestCase):
    def test_rotated_refresh_survives_validation_failure_without_publishing_access(self):
        state = saved()
        writes = []
        with tempfile.TemporaryDirectory() as home, patch.object(auth.Path, 'home', return_value=Path(home)), \
                patch.object(auth, 'load', return_value=state), patch.object(auth, 'store', side_effect=lambda _, s: writes.append(copy.deepcopy(s))), \
                patch.object(auth, 'request', return_value={'access_token': token(extra=100), 'refresh_token': 'new'}), \
                patch.object(auth, 'validate', side_effect=auth.AuthError('AUTH_HTTP_503')):
            with self.assertRaises(auth.AuthError):
                auth.refresh()
        self.assertEqual(writes[-1]['refresh_bootstrap']['refresh_token'], 'new')
        self.assertEqual(writes[-1]['templates'], state['templates'])

    def test_concurrent_loser_reuses_rotated_token(self):
        state = saved()
        with tempfile.TemporaryDirectory() as home, patch.object(auth.Path, 'home', return_value=Path(home)), \
                patch.object(auth, 'load', return_value=state), patch.object(auth, 'request') as request:
            self.assertEqual(auth.refresh(rejected_token='stale'), state)
            request.assert_not_called()

    def test_non_guest_rejected(self):
        with patch.object(auth, 'request') as request:
            with self.assertRaisesRegex(auth.AuthError, 'FRESH_GUEST_TOKEN_REQUIRED'):
                auth.validate(saved(), token('CUSTOMER'), 1)
            request.assert_not_called()

    def test_401_refreshes_and_retries_only_once(self):
        state = saved()
        error = urllib.error.HTTPError('https://example.invalid', 401, 'unauthorized', {}, None)
        with patch.object(search, 'load', return_value=state), patch.object(auth, 'refresh', return_value=state) as refresh, \
                patch.object(search.urllib.request, 'build_opener') as opener:
            opener.return_value.open.side_effect = error
            with self.assertRaisesRegex(search.SearchError, 'AUTH_EXPIRED'):
                search.Catalog().fetch('quik', 'milk')
            self.assertEqual(opener.return_value.open.call_count, 2)
            refresh.assert_called_once()

    def test_403_does_not_rotate(self):
        with patch.object(search, 'load', return_value=saved()), patch.object(auth, 'refresh') as refresh, \
                patch.object(search.urllib.request, 'build_opener') as opener:
            opener.return_value.open.side_effect = urllib.error.HTTPError('https://example.invalid', 403, 'forbidden', {}, None)
            with self.assertRaises(search.SearchError):
                search.Catalog().fetch('quik', 'milk')
            refresh.assert_not_called()


if __name__ == '__main__':
    unittest.main()
