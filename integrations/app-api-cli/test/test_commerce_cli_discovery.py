"""Read-only menu/choice CLI boundaries; no account or merchant traffic."""
import os as _os, tempfile as _tempfile
# commerce_cli reads the pause file at import; the owner's real one must not refuse test orders.
_os.environ['ORDERING_PAUSE_FILE'] = _os.path.join(_tempfile.gettempdir(), 'ordering-pause-test-absent', 'ordering-paused')
import contextlib
import io
import json
import unittest
from unittest.mock import Mock, patch

import commerce_cli as cli
from talabat_menu_choices import MenuEntry, MenuIndex, ChoiceOption, ChoiceSection, ItemChoices


@unittest.skip('Talabat retired by owner 2026-11-07: menu/choices refuse (test_talabat_retired)')
class DiscoveryCLITests(unittest.TestCase):
    def setUp(self):
        self.item=MenuEntry(123,'Pizza',6000,6000,True,'Pizza')
        self.menu=MenuIndex([(123,self.item)])
        self.choices=ItemChoices(123,(ChoiceSection(77,123,'Extras',0,3,(
            ChoiceOption(987,77,'Extra ham',1600,1600,False),)),))
        self.checkout=Mock()

    def run_cli(self,args):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            code=cli.main(args)
        return code,json.loads(out.getvalue())

    def test_menu_returns_complete_catalog_without_cart_or_financial_calls(self):
        entries=[(n,MenuEntry(n,'Item '+str(n),n*100,n*100,False,'Food')) for n in range(1,351)]
        with patch.object(cli,'CommerceAuth') as auth, \
             patch.object(cli.talabat,'Checkout',return_value=self.checkout) as checkout, \
             patch('talabat_menu_choices.fetch_menu_index',return_value=MenuIndex(entries)), \
             patch('talabat_menu_choices.fetch_item_choices') as choices, \
             patch.object(cli.journal,'open_flow',side_effect=AssertionError('no journal flow')):
            auth.return_value.fresh_before_mutation.return_value.mutation_account.return_value={'private':'secret'}
            code,result=self.run_cli(['menu','talabat','--branch','444'])
        self.assertEqual(code,0,result)
        self.assertEqual(len(result['items']),350)
        self.assertFalse(result['cart_mutation'])
        self.assertFalse(result['financial_send'])
        self.assertNotIn('secret',json.dumps(result))
        self.checkout.resolve_restaurant.assert_called_once_with(444)
        choices.assert_not_called()
        for name in ('create_cart','prepare','submit_place','submit_payment'):
            getattr(self.checkout,name).assert_not_called()
        for key in ('journal','receipt'):
            with self.assertRaisesRegex(cli.journal.JournalError,'MENU_DISCOVERY_MUTATION_FORBIDDEN'):
                checkout.call_args.kwargs[key]({})

    def test_choices_exposes_native_ids_names_prices_and_selection_bounds(self):
        with patch.object(cli,'CommerceAuth'), \
             patch.object(cli.talabat,'Checkout',return_value=self.checkout), \
             patch('talabat_menu_choices.fetch_menu_index',return_value=self.menu), \
             patch('talabat_menu_choices.fetch_item_choices',return_value=self.choices) as choices:
            code,result=self.run_cli(['choices','talabat','--branch','444','--item','123'])
        self.assertEqual(code,0,result)
        choices.assert_called_once_with(self.checkout,444,123)
        section=result['choices']['sections'][0]
        self.assertEqual((section['section_id'],section['min_select'],section['max_select']),(77,0,3))
        self.assertEqual(section['options'][0]['option_id'],987)
        self.assertEqual(section['options'][0]['price_minor'],1600)
        self.assertFalse(result['financial_send'])

    def test_unknown_item_never_fetches_choices(self):
        with patch.object(cli,'CommerceAuth'), \
             patch.object(cli.talabat,'Checkout',return_value=self.checkout), \
             patch('talabat_menu_choices.fetch_menu_index',return_value=self.menu), \
             patch('talabat_menu_choices.fetch_item_choices') as choices:
            code,result=self.run_cli(['choices','talabat','--branch','444','--item','999'])
        self.assertEqual(code,1)
        self.assertEqual(result['error'],'EXACT_CATALOG_ITEM_UNAVAILABLE')
        choices.assert_not_called()

    def test_invalid_identity_refused_before_auth(self):
        for args,error in ((['menu','talabat','--branch','0'],'BRANCH_ID_INVALID'),
                           (['choices','talabat','--branch','444','--item','-1'],'MENU_ITEM_ID_INVALID')):
            with self.subTest(args=args),patch.object(cli,'CommerceAuth',side_effect=AssertionError('no auth')):
                code,result=self.run_cli(args)
            self.assertEqual(code,1)
            self.assertEqual(result['error'],error)


if __name__=='__main__':unittest.main()
