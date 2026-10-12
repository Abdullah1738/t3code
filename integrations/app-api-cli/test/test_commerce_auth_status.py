import copy
import json
import time
import unittest
from unittest.mock import MagicMock

import commerce_auth_status as commerce
import talabat_auth as talabat


class CommerceTest(unittest.TestCase):
    def backend(self):
        backend = MagicMock()
        backend.TalabatError = talabat.TalabatError
        backend.ACCOUNT = 'talabat-account'
        backend.refresh.return_value = {'renewed': False}
        backend.read_store.return_value = {'auth': {'access_token': 'private-token'}}
        backend.binding.side_effect = copy.deepcopy
        backend.remaining_time.side_effect = lambda end: end - time.monotonic()
        return backend

    def test_verticals_explicit_and_no_guest_alias(self):
        self.assertEqual(set(commerce.VERTICAL_SESSIONS['talabat'].values()), {'talabat-account'})
        with self.assertRaisesRegex(commerce.AuthError, 'INVALID_COMMERCE_VERTICAL'):
            commerce.CommerceAuth().status('talabat', 'food')

    def test_fresh_mutation_reuses_existing_refresh_and_profile(self):
        backend = self.backend()
        manager = commerce.CommerceAuth(talabat=backend)
        snapshot = manager.fresh_before_mutation('talabat', 'shops')
        backend.refresh.assert_called_once()
        backend.validate.assert_called_once()
        self.assertEqual(snapshot.mutation_account('shops')['auth']['access_token'], 'private-token')
        with self.assertRaisesRegex(commerce.AuthError, 'ALREADY_USED'):
            snapshot.mutation_account('shops')
        self.assertNotIn('private-token', repr(snapshot))

    def test_401_one_renewal_original_rejected_token_and_deadline(self):
        backend = self.backend()
        backend.validate.side_effect = [talabat.TalabatError('AUTH_EXPIRED_RENEWAL_REQUIRED'), None]
        manager = commerce.CommerceAuth(talabat=backend)
        end = time.monotonic() + 4
        manager.fresh_before_mutation('talabat', 'mart', deadline=end)
        self.assertEqual(backend.refresh.call_count, 2)  # initial local check then one grant
        self.assertEqual(backend.refresh.call_args.kwargs['rejected_token'], 'private-token')
        self.assertEqual(backend.refresh.call_args.kwargs['deadline'], end)

    def test_initial_rotation_then_profile401_does_not_rotate_twice(self):
        backend = self.backend()
        backend.refresh.return_value = {'renewed': True}
        backend.validate.side_effect = talabat.TalabatError('AUTH_EXPIRED_RENEWAL_REQUIRED')
        with self.assertRaises(talabat.TalabatError):
            commerce.CommerceAuth(talabat=backend).fresh_before_mutation('talabat', 'restaurants')
        backend.refresh.assert_called_once()

    def test_403_never_retry_or_login(self):
        backend = self.backend()
        backend.validate.side_effect = talabat.TalabatError('AUTH_FORBIDDEN')
        with self.assertRaises(talabat.TalabatError):
            commerce.CommerceAuth(talabat=backend).fresh_before_mutation('talabat', 'shops')
        backend.refresh.assert_called_once()
        backend.login_request.assert_not_called()
        result = commerce.failure('talabat', 'shops', talabat.TalabatError('AUTH_FORBIDDEN'))
        self.assertEqual(result['action'], 'manual_auth_challenge')
        self.assertFalse(result['retry'])

    def test_recovery_error_handoff_never_exposes_transport_details(self):
        backend = self.backend()
        backend.refresh.side_effect = OSError('private-token')
        result = commerce.CommerceAuth(talabat=backend).recover('talabat', 'mart')
        self.assertNotIn('private-token', json.dumps(result))
        self.assertFalse(result['automatic_otp'])
        self.assertFalse(result['mutation_retry'])

    def test_status_projects_only_known_fields_and_states(self):
        backend = self.backend()
        backend.status.return_value = {'account_verified': True, 'expired': True,
            'refresh_material_present': True, 'refresh_verified': True,
            'maintenance_state': 'published', 'access_token': 'private-token'}
        manager = commerce.CommerceAuth(talabat=backend)
        result = manager.status('talabat', 'shops')
        self.assertEqual(result['action'], 'renew_before_next_operation')
        self.assertNotIn('private-token', json.dumps(result))
        backend.status.return_value['maintenance_state'] = 'private-state'
        self.assertEqual(manager.status('talabat', 'shops')['maintenance_state'], 'unknown')

    def test_missing_material_and_revoked_grant_manual_handoff(self):
        for code in ('REFRESH_MATERIAL_MISSING_EXPLICIT_LOGIN_REQUIRED', 'AUTH_REQUEST_REJECTED',
                     'NO_FRESH_AUTH_MANUAL_RECOVERY_REQUIRED'):
            result = commerce.failure('talabat', 'mart', talabat.TalabatError(code))
            self.assertEqual(result['action'], 'manual_account_recovery')
            self.assertTrue(result['human_challenge_possible'])

    def test_reconcile_uses_retained_candidate_never_login(self):
        backend = self.backend()
        backend.status.return_value = {}
        commerce.CommerceAuth(talabat=backend).recover('talabat', 'mart', reconcile=True)
        backend.reconcile.assert_called_once()
        backend.refresh.assert_not_called()
        backend.login_request.assert_not_called()


if __name__ == '__main__':
    unittest.main()
