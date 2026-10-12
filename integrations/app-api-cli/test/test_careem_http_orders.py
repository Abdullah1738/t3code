import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import careem_http_orders as c
import careem_account_auth as a


class CareemReadTest(unittest.TestCase):
    def test_static_status_never_claims_live_delivery(self):
        data={'info':{'reference_id':'123','service':'food','status':'Completed','pin':'private'},
              'sections':[{'payment':'private'}]}
        out=c.project(data,'123','food')
        self.assertEqual(out['status'],'unknown')
        self.assertEqual(out['raw_status'],'Completed')
        self.assertNotIn('private',str(out))
        self.assertIsNone(out['eta']);self.assertIsNone(out['rider'])
        with self.assertRaises(c.CareemError):c.project(data,'456','food')
        with self.assertRaises(c.CareemError):c.project(data,'123','shops')

    def test_account_required_and_no_guest_or_ui_fallback(self):
        with patch.object(a,'account',side_effect=a.AccountError('ACCOUNT_CAPTURE_REQUIRED')),patch.object(a,'_transport') as request:
            with self.assertRaisesRegex(c.CareemError,'CAPTURE_REQUIRED'):c.track('123')
            request.assert_not_called()

    def test_mutation_services_paths_and_ids_rejected(self):
        with patch.object(a,'account') as account:
            for service in ['rides','box','shops','groceries']:
                with self.assertRaises(c.CareemError):c.track('123',service=service)
            for oid in ['../123','123?x=1','']:
                with self.assertRaises(c.CareemError):c.track(oid)
            account.assert_not_called()

    def test_read_contract_and_profile_precedes_tracking(self):
        saved={'auth':{'access_token':'fixture'},'identity':{'phone_number':'+971500000000'},
               'client':{'headers':{'x-careem-userid':'guest'}}}
        with patch.object(a,'account',return_value=saved),patch.object(a,'verify_customer') as verify,patch.object(a,'_transport',return_value=(200,{
                'info':{'reference_id':'123','service':'food','status':'Preparing'}})) as request:
            result=c.track('123')
            verify.assert_called_once()
            args=request.call_args.args
            self.assertEqual(args[0],'GET')
            self.assertTrue(args[1].startswith(c.HOST+'/v1/activity-tracker/food/123?'))
            self.assertNotIn('x-careem-userid',args[2])
            self.assertIsNone(args[3])
            self.assertEqual(result['status'],'unknown')


if __name__=='__main__':unittest.main()
