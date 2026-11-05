#!/usr/bin/env python3
"""Check behavioral invariants with an independent exhaustive oracle."""
import itertools
import json
import random
import tempfile
import unittest
from pathlib import Path

from plan_invoice import PlanningError, allocate, cents, invoice_text, legal_parts, legal_options, load_tax_overrides, summary_row, red


def groups(amounts):
    return [{'amount_cents': amount, 'source_rows': [i + 4], 'fields': {'legal': f'公司{i}(L{i})'}}
            for i, amount in enumerate(amounts)]


def oracle(amounts, price, target):
    feasible = []
    for amount in amounts:
        choices = [0]
        for quantity in range(1, target + 1):
            remainder = amount - price * quantity
            if remainder == 0 or (remainder >= 30000 and remainder % 100 == 0):
                choices.append(quantity)
        feasible.append(choices)
    counts = [sum(q > 0 for q in choice) for choice in itertools.product(*feasible) if sum(choice) == target]
    return min(counts) if counts else None


class AllocationTests(unittest.TestCase):
    def test_historic_red_palette_variants(self):
        from types import SimpleNamespace
        from openpyxl.styles import Color, Font
        from validate_invoice_outputs import is_red
        # Excel's standard palette has two red indices; neither can fund a new batch.
        for color in (Color(indexed=2), Color(indexed=10), Color(rgb='FFFF0000')):
            cell = SimpleNamespace(font=Font(color=color))
            self.assertTrue(red(cell))
            self.assertTrue(is_red(cell))
        cell = SimpleNamespace(font=Font(color=Color(indexed=0)))
        self.assertFalse(red(cell))
        self.assertFalse(is_red(cell))

    def test_validator_fails_closed_for_runtime_conditional_formatting(self):
        from openpyxl import Workbook
        from openpyxl.formatting.rule import CellIsRule
        from openpyxl.styles import PatternFill
        from validate_invoice_outputs import conditional_formatting_on_cost
        book = Workbook()
        sheet = book.active
        sheet['E2'] = 100
        self.assertFalse(conditional_formatting_on_cost(sheet, 5, 3))
        sheet.conditional_formatting.add('E4:E100', CellIsRule(
            operator='greaterThan', formula=['0'],
            fill=PatternFill(fill_type='solid', fgColor='FFFF0000')))
        self.assertTrue(conditional_formatting_on_cost(sheet, 5, 3))
        self.assertFalse(conditional_formatting_on_cost(sheet, 4, 3))

    def test_exact_money_and_legal_entity(self):
        self.assertEqual(cents('21'), 2100)
        self.assertEqual(cents('0.05'), 5)
        self.assertEqual(legal_parts('某公司(L100001)'), legal_parts('L100001(某公司)'))
        self.assertNotEqual(legal_parts('甲公司(L100001)'), legal_parts('乙公司(L100001)'))
        self.assertEqual(legal_parts('示例公司（分部）(L100001)')[0], '示例公司（分部）')
        with self.assertRaises(PlanningError):
            legal_parts('示例公司（分部(L100001)')
        with self.assertRaises(PlanningError):
            legal_parts('ABC2科技有限公司')
        with self.assertRaises(PlanningError):
            legal_parts('ABC123 示例公司')
        with self.assertRaises(PlanningError):
            cents('0.001')

    def test_remainder_boundary_and_fractional_price(self):
        # 321 - 21 = 300 is the inclusive threshold.
        self.assertEqual(legal_options(32100, 2100, 20)[0], (1, 1, 1))
        self.assertEqual(allocate(groups([32100]), 2100, 1)[0]['remainder_cents'], 30000)
        self.assertEqual(legal_options(32099, 2100, 20), (None, None))
        self.assertEqual(allocate(groups([32200]), 2100, 1)[0]['remainder_cents'], 30100)
        self.assertEqual(allocate(groups([32150]), 2150, 1)[0]['remainder_cents'], 30000)
        with self.assertRaises(PlanningError):
            allocate(groups([32149]), 2150, 1)
        self.assertEqual(allocate(groups([32250]), 2150, 1)[0]['remainder_cents'], 30100)

    def test_non_greedy_exact_combination(self):
        result = allocate(groups([31500, 33600, 12600]), 2100, 21)
        self.assertEqual(len(result), 2)
        self.assertEqual(sum(group['used_cents'] for group in result), 44100)

    def test_fractional_group_sum_not_rounded(self):
        with self.assertRaises(PlanningError):
            allocate(groups([100750]), 2100, 10)
        self.assertEqual(sum(group['quantity'] for group in allocate(groups([100800]), 2100, 10)), 10)

    def test_dynamic_programming_against_brute_force(self):
        rng = random.Random(2042)
        for _ in range(90):
            price = rng.choice([2100, 2150, 10000, 25000])
            target = rng.randrange(1, 10)
            amounts = [rng.randrange(0, 25) * 5000 + rng.choice([0, 50, 100]) for _ in range(3)]
            expected = oracle(amounts, price, target)
            if expected is None:
                with self.assertRaises(PlanningError):
                    allocate(groups(amounts), price, target)
            else:
                actual = allocate(groups(amounts), price, target)
                self.assertEqual(len(actual), expected)
                self.assertEqual(sum(group['quantity'] for group in actual), target)

    def test_earlier_source_tie(self):
        self.assertEqual(allocate(groups([50000, 200000]), 2100, 5)[0]['source_rows'], [4])

    def test_summary_is_not_an_expense(self):
        blank = dict.fromkeys(('applicant', 'department', 'use_center', 'cost_center', 'legal', 'purpose'))
        self.assertTrue(summary_row({**blank, 'applicant': '合计'}, 100000))
        self.assertTrue(summary_row(blank, '=SUM(E4:E20)'))
        self.assertFalse(summary_row({**blank, 'applicant': '张某'}, 500))


class TaxTests(unittest.TestCase):
    def entry(self, kind='一般纳税人-一般征收'):
        return {'L100001': [{'name': '某公司', 'code': 'L100001', 'kind': kind,
            'credit': '001234567890123456', 'address': '某地址', 'bank': '某银行',
            'account': '00123456789012345678', 'source_row': 2}]}

    def test_format_and_long_text(self):
        text, _ = invoice_text('某公司(L100001)', self.entry())
        self.assertEqual(text.split('\n'), ['某公司', '001234567890123456', '某地址', '某银行', '00123456789012345678', '', '专票'])
        for kind in ('小规模纳税人', '一般纳税人-简易征收'):
            self.assertEqual(invoice_text('某公司(L100001)', self.entry(kind))[0], '001234567890123456')

    def test_duplicate_name_unknown_and_precision_fail(self):
        duplicate = self.entry()
        duplicate['L100001'] *= 2
        with self.assertRaises(PlanningError):
            invoice_text('某公司(L100001)', duplicate)
        with self.assertRaises(PlanningError):
            invoice_text('另一公司(L100001)', self.entry())
        with self.assertRaises(PlanningError):
            invoice_text('某公司(L100001)', self.entry('一般纳税人'))
        numeric = self.entry()
        numeric['L100001'][0]['account'] = 123456789012345678
        with self.assertRaises(PlanningError):
            invoice_text('某公司(L100001)', numeric)

    def test_confirmed_correction_only(self):
        data = self.entry()
        data['L100001'][0].update(address='某地 行', bank='某银行支')
        with self.assertRaises(PlanningError):
            invoice_text('某公司(L100001)', data)
        with self.assertRaises(PlanningError):
            invoice_text('某公司(L100001)', data, {'L100001': {'address': '某地', 'bank': '某银行支行'}})
        text, _ = invoice_text('某公司(L100001)', data, {'L100001': {
            'confirmed_by_user': True, 'reason': '本次用户确认', 'batch_ids': ['batch-a'],
            'address': '某地', 'bank': '某银行支行'}}, 'batch-a')
        self.assertIn('某地\n某银行支行\n', text)

    def test_correction_scope_is_enforced(self):
        data = self.entry()
        data['L100001'][0].update(address='某地 行', bank='某银行支')
        override = {'L100001': {
            'confirmed_by_user': True, 'reason': '批次确认', 'batch_ids': ['batch-a'],
            'address': '某地', 'bank': '某银行支行',
        }}
        with self.assertRaises(PlanningError):
            invoice_text('某公司(L100001)', data, override, 'batch-b')
        future = {'L100001': {
            'confirmed_by_user': True, 'reason': '未来批次授权',
            'scope': {'applies_to_all_future_batches': True,
                      'effective_from_utc': '2026-11-05T00:00:00Z'},
            'address': '某地', 'bank': '某银行支行',
        }}
        text, _ = invoice_text('某公司(L100001)', data, future, 'batch-b', '2026-11-06T00:00:00+08:00')
        self.assertIn('某银行支行', text)
        with self.assertRaises(PlanningError):
            invoice_text('某公司(L100001)', data, future, 'batch-old', '2026-11-04T00:00:00+08:00')

    def test_override_file_requires_entities_and_scope(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'overrides.json'
            path.write_text(json.dumps({'entities': {'L100001': {
                'confirmed_by_user': True, 'reason': '本批确认', 'address': '某地址',
                'scope': {'batch_ids': ['batch-a']},
            }}}, ensure_ascii=False), encoding='utf-8')
            self.assertIn('L100001', load_tax_overrides(path))
            path.write_text(json.dumps({'L100001': {'confirmed_by_user': True, 'reason': '旧格式', 'address': '某地址'}}),
                            encoding='utf-8')
            with self.assertRaises(PlanningError):
                load_tax_overrides(path)
            path.write_text(json.dumps({'entities': {'L100001': {
                'confirmed_by_user': True, 'reason': '缺少生效起点',
                'scope': {'applies_to_all_future_batches': True}, 'address': '某地址',
            }}}, ensure_ascii=False), encoding='utf-8')
            with self.assertRaises(PlanningError):
                load_tax_overrides(path)
            path.write_text(json.dumps({'entities': {'L100001': {
                'confirmed_by_user': True, 'reason': '范围冲突', 'address': '某地址',
                'scope': {'batch_ids': ['batch-a'], 'applies_to_all_future_batches': True,
                          'effective_from_utc': '2026-11-05T00:00:00Z'},
            }}}, ensure_ascii=False), encoding='utf-8')
            with self.assertRaisesRegex(PlanningError, 'cannot combine'):
                load_tax_overrides(path)
            path.write_text(json.dumps({'entities': {'L100001': {
                'confirmed_by_user': True, 'reason': '嵌套范围遮蔽', 'address': '某地址', 'batch_ids': [],
                'scope': {'batch_ids': ['batch-a'], 'applies_to_all_future_batches': True,
                          'effective_from_utc': '2026-11-05T00:00:00Z'},
            }}}, ensure_ascii=False), encoding='utf-8')
            with self.assertRaisesRegex(PlanningError, 'declared both'):
                load_tax_overrides(path)

    def test_tax_code_column_mixup(self):
        data = self.entry()
        data['L100001'][0].update(credit='L100001', kind=None)
        with self.assertRaises(PlanningError) as error:
            invoice_text('某公司(L100001)', data)
        self.assertIn('actual tax ID', str(error.exception))
        self.assertIn('classification', str(error.exception))


if __name__ == '__main__':
    unittest.main()
