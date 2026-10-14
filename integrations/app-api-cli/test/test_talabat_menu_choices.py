"""talabat_menu_choices: live menu/choice catalog parsing and merchant-truth validation."""
import unittest

import talabat_http_checkout as h
import talabat_http_orders as orders
import talabat_menu_choices as mc

MENU = {'vendor': {'result': {'restaurant': {'bid': 717327}}},
        'menu': {'result': {'menu': {'menuSection': [
            {'nm': 'Pizza', 'itm': [
                {'id': 157740044, 'nm': 'Hawaiian Pizza - 958 Kcal', 'pr': 54, 'opr': 60, 'icc': True},
                {'id': 157740045, 'nm': 'Margherita', 'pr': 45, 'opr': 50, 'icc': False}]},
            {'nm': 'Shakes', 'itm': [
                {'id': 157740044, 'nm': 'Hawaiian Pizza - 958 Kcal', 'pr': 54, 'opr': 60, 'icc': True},
                {'id': 157740099, 'nm': 'Chamomile Tea', 'pr': 18, 'opr': 18, 'icc': False}]}]}}}}

CHOICES = {'result': {'choiceForItem': [{'itemId': '157740044', 'choiceSections': [
    {'id': 2130621, 'iid': 157740044, 'nm': 'Extra Hawaiian Pizza Toppings:', 'mnq': 0, 'mxq': 1,
     'st': 'Choose up to 1 items', 'sortOrder': 1, 'ct': 'default', 'awm': False, 'vt': '',
     'ich': [{'id': 549025015, 'nm': 'Extra Turkey Ham - 30g', 'pr': 14.4, 'opr': 16, 'ds': False,
              'hsc': False, 'ids': True, 'subCategories': None, 'tag': {'rows': []}},
             {'id': 549025016, 'nm': 'Extra Pineapple - 30g', 'pr': 6.3, 'opr': 7, 'ds': False,
              'hsc': False, 'ids': True, 'subCategories': None}]},
    {'id': 2130622, 'iid': 157740044, 'nm': 'Sauces', 'mnq': 1, 'mxq': 2,
     'ich': [{'id': 549025100, 'nm': 'Garlic sauce', 'pr': 3, 'opr': 3, 'subCategories': None},
             {'id': 549025101, 'nm': 'Chili sauce', 'pr': 3, 'opr': 3, 'subCategories': None}]}]}]}}


class MenuIndexTests(unittest.TestCase):
    def test_parse_menu_walks_short_keys_and_flags_customizable(self):
        index = mc.parse_menu(MENU)
        self.assertEqual(sorted(index.entries), [157740044, 157740045, 157740099])
        entry = index.entries[157740044]
        self.assertEqual((entry.name, entry.price_minor, entry.original_price_minor,
                          entry.customizable),
                         ('Hawaiian Pizza - 958 Kcal', 5400, 6000, True))
        self.assertFalse(index.entries[157740099].customizable)

    def test_conflicting_duplicate_names_refused_identical_duplicates_tolerated(self):
        import copy
        bad = copy.deepcopy(MENU)
        bad['menu']['result']['menu']['menuSection'][1]['itm'][0]['nm'] = 'Hawaiian Pizza XXL'
        with self.assertRaisesRegex(orders.TalabatError, 'MENU_DUPLICATE_ITEM_CONFLICT'):
            mc.parse_menu(bad)

    def test_invalid_menu_shapes_refused(self):
        for data in (None, [], {}, {'menu': {}}, {'menu': {'result': {}},
                'vendor': {'result': {'restaurant': {'bid': 1}}}}):
            with self.subTest(data=data), self.assertRaises(orders.TalabatError):
                mc.parse_menu(data)


class ChoiceCatalogTests(unittest.TestCase):
    def test_parse_choices_sections_and_options(self):
        item = mc.parse_choices(CHOICES, 157740044)
        self.assertEqual(item.item_id, 157740044)
        self.assertEqual([s.section_id for s in item.sections], [2130621, 2130622])
        self.assertEqual(item.sections[0].min_select, 0)
        self.assertEqual(item.sections[1].min_select, 1)
        self.assertEqual(item.sections[1].max_select, 2)
        self.assertEqual([o.option_id for o in item.sections[0].options],
                         [549025015, 549025016])
        self.assertEqual(item.sections[0].options[0].price_minor, 1440)
        self.assertEqual(mc.choice_catalog(item), {
            549025015: {'section_id': 2130621, 'name': 'Extra Turkey Ham - 30g',
                         'original_price_minor': 1600},
            549025016: {'section_id': 2130621, 'name': 'Extra Pineapple - 30g',
                         'original_price_minor': 700},
            549025100: {'section_id': 2130622, 'name': 'Garlic sauce', 'original_price_minor': 300},
            549025101: {'section_id': 2130622, 'name': 'Chili sauce', 'original_price_minor': 300}})

    def test_empty_choice_for_item_means_no_sections(self):
        for data in ({'result': {'choiceForItem': []}},
                     {'result': {'choiceForItem': None}},
                     {'result': {}}):
            with self.subTest(data=data):
                item = mc.parse_choices(data, 1)
                self.assertEqual(item.sections, ())

    def test_validate_line_choices_enforces_merchant_bounds(self):
        item = mc.parse_choices(CHOICES, 157740044)
        # Ham from section 1 (0..1) + one sauce from required section 2 (1..2).
        valid = ((549025015, 1, ()), (549025100, 1, ()))
        self.assertEqual(mc.validate_line_choices(item, valid), valid)
        # Required section unsatisfied.
        with self.assertRaisesRegex(orders.TalabatError, 'MENU_CHOICE_SECTION_BOUNDS_FAILED'):
            mc.validate_line_choices(item, ((549025015, 1, ()),))
        # Two toppings exceeds mxq of the first section.
        with self.assertRaisesRegex(orders.TalabatError, 'MENU_CHOICE_SECTION_BOUNDS_FAILED'):
            mc.validate_line_choices(item, ((549025015, 1, ()), (549025016, 1, ()),
                                            (549025100, 1, ())))
        # Unknown option id.
        with self.assertRaisesRegex(orders.TalabatError, 'MENU_CHOICE_UNKNOWN'):
            mc.validate_line_choices(item, ((999, 1, ()), (549025100, 1, ())))
        # Duplicated choice id in one line.
        with self.assertRaisesRegex(orders.TalabatError, 'FOOD_CHOICE_DUPLICATED_IN_LINE'):
            mc.validate_line_choices(item, ((549025015, 1, ()), (549025015, 1, ()),
                                            (549025100, 1, ())))
        # A top-level option is not a child of a different option.
        with self.assertRaisesRegex(orders.TalabatError, 'MENU_SUBCHOICE_UNKNOWN_FOR_PARENT'):
            mc.validate_line_choices(item, ((549025015, 1, (549025100,)), (549025100, 1, ())))
        # Zero/invalid quantities.
        for bad in (((549025015, 0, ()), (549025100, 1, ())), ((549025015, True, ()), (549025100, 1, ()))):
            with self.subTest(bad=bad), self.assertRaises(orders.TalabatError):
                mc.validate_line_choices(item, bad)

    def test_choices_without_sections_means_not_customizable(self):
        item = mc.ItemChoices(157740045, ())
        with self.assertRaisesRegex(orders.TalabatError, 'MENU_ITEM_NOT_CUSTOMIZABLE'):
            mc.validate_line_choices(item, ((549025015, 1, ()),))


if __name__ == '__main__':
    unittest.main()
