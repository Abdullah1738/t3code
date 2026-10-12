import copy
import unittest
import noon_marketplace_invoice as i
from noon_marketplace_native_shape import native_invoice_observations


class InvoiceTests(unittest.TestCase):
    def setUp(self):
        self.session={'subtotal':20,'total':25,'orderPaymentAmount':25,'useCredits':False,
            'invoice':{'sections':[{'entries':[{'title':'Subtotal','amount':'AED 20.00'},
                {'title':'Delivery','amount':'<b>AED 5.00</b>'},
                {'title':'Total','amount':'AED 25.00'}]}]}}

    def review(self):
        return i.LocalInvoiceReview(i.digest(self.session),i.digest(self.session['invoice']),
            tuple(i.InvoiceRowRole(('invoice','sections',0,'entries',n),row['title'],role)
                for n,(row,role) in enumerate(zip(self.session['invoice']['sections'][0]['entries'],('subtotal','fee','total')))),
            'explicit-local-review')

    def run_review(self,review=None):
        return i.native_invoice_reconcile(self.session,native_invoice_observations(self.session),local_review=review or self.review())

    def test_native_html_rows_reconcile_without_invented_fee_code(self):
        result=self.run_review()
        self.assertEqual(result['fee_minor'],500)
        self.assertEqual(result['scope'],'native-invoice-arithmetic-only')
        self.assertNotIn('fee_code',str(result))

    def test_no_default_roles_or_analytics_role_inference(self):
        self.session['invoice']['sections'][0]['entries'][1]['breakdown']={'analyticsFeeType':'subtotal'}
        with self.assertRaisesRegex(i.ReviewError,'LOCAL_INVOICE_LABEL_REVIEW_REQUIRED'):
            i.native_invoice_reconcile(self.session,native_invoice_observations(self.session))

    def test_complete_row_inventory_and_snapshot_bound(self):
        review=self.review()
        self.session['invoice']['sections'][0]['entries'].append({'title':'Extra','amount':'AED 1.00'})
        with self.assertRaisesRegex(i.ReviewError,'SNAPSHOT_MISMATCH'):self.run_review(review)
        with self.assertRaisesRegex(i.ReviewError,'INCOMPLETE_OR_CHANGED'):
            i.native_invoice_reconcile(self.session,native_invoice_observations(self.session)[:-1],local_review=self.review())

    def test_duplicate_visible_total_and_unknown_markup_reject(self):
        rows=self.session['invoice']['sections'][0]['entries']
        rows[1]['title']='<b>Total</b>'
        with self.assertRaisesRegex(i.ReviewError,'DUPLICATE_INVOICE_LABEL'):self.run_review()
        rows[1]['title']='Delivery';rows[1]['amount']='<s>AED 9</s> AED 5'
        with self.assertRaises(i.ReviewError):self.run_review()

    def test_real_payable_credits_and_donation_reject(self):
        for key,value in [('total',26),('orderPaymentAmount',24),('useCredits',True),('donation',1)]:
            old=copy.deepcopy(self.session);self.session[key]=value
            with self.subTest(key=key),self.assertRaises(i.ReviewError):self.run_review()
            self.session=old

    def test_existing_membership_not_misclassified_as_new_charge(self):
        self.session['integratedNoonone']={'enrolled':True}
        self.assertEqual(self.run_review()['total_minor'],2500)
        self.assertIn('complete-extras-inventory',self.run_review()['unsupported'])

    def test_large_invoice_has_no_arbitrary_row_limit(self):
        entries = [{'title': 'Subtotal', 'amount': 'AED 20.00'}]
        entries += [{'title': f'Fee {n}', 'amount': 'AED 1.00'} for n in range(1001)]
        entries.append({'title': 'Total', 'amount': 'AED 1021.00'})
        self.session.update(total=1021, orderPaymentAmount=1021,
            invoice={'sections': [{'entries': entries}]})
        roles = ['subtotal'] + ['fee'] * 1001 + ['total']
        review = i.LocalInvoiceReview(i.digest(self.session), i.digest(self.session['invoice']),
            tuple(i.InvoiceRowRole(('invoice', 'sections', 0, 'entries', n), row['title'], role)
                  for n, (row, role) in enumerate(zip(entries, roles))), 'explicit-local-review')
        result = self.run_review(review)
        self.assertEqual(result['fee_minor'], 100100)
        self.assertEqual(result['total_minor'], 102100)


if __name__=='__main__':unittest.main()
