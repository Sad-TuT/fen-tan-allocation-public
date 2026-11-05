#!/usr/bin/env python3
"""Read-only invoice/export audit. Never opens an xlsx for writing.

Usage:
  python validate_invoice_outputs.py --metadata <authoring.json> --report <report.json>
  python validate_invoice_outputs.py --metadata <authoring.json> --context <context.json>

The context supplies the requested price, quantity and total; otherwise metadata.context
is used. The report is optional; stdout always contains JSON and failure exits nonzero.
Only the requested report JSON is written. Input/output workbooks and indexes are read
only. Business expectations are reconstructed from source cells and actual invoice
cells; metadata mappings and plan totals are checked as additional evidence.
"""
import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
import hashlib
import json
from pathlib import Path
import re
import sys
import traceback

import openpyxl


FIELDS = ('applicant', 'department', 'use_center', 'cost_center', 'legal', 'purpose')
SOURCE = {
    'applicant': ('申领人',), 'department': ('申领部门',),
    'use_center': ('使用部门', '使用中心'), 'cost_center': ('成本中心',),
    'legal': ('费用承担法律主体',), 'purpose': ('申领用途',),
    'amount': ('成本', '可用金额', '剩余金额', '金额'),
}
INVOICE = {**{k: v for k, v in SOURCE.items() if k != 'amount'},
           'amount': ('部门使用金额',), 'invoice': ('开票明细',),
           'price': ('单价',), 'quantity': ('数量',), 'total': ('总计金额',)}
TAX = {'code': ('法律主体编码',), 'name': ('实际主体名称',),
       'kind': ('当前主体类型',), 'credit': ('社会统一信用代码', '统一社会信用代码'),
       'address': ('注册地址',), 'bank': ('开户行',), 'account': ('银行基本户账号',)}
ERRORS = {'#REF!', '#DIV/0!', '#VALUE!', '#NAME?', '#N/A', '#NUM!', '#NULL!',
          '#SPILL!', '#CALC!', '#GETTING_DATA'}


class AuditFatal(Exception):
    pass


class Checks:
    def __init__(self):
        self.count = 0
        self.failures = 0
        self.errors = []

    def check(self, condition, name, detail=None):
        self.count += 1
        if not condition:
            self.failures += 1
            if len(self.errors) < 150:
                self.errors.append({'check': name, 'detail': detail})
        return bool(condition)

    def equal(self, actual, expected, name):
        return self.check(actual == expected, name,
                          {'actual': str(actual)[:500], 'expected': str(expected)[:500]})

    def need(self, condition, name, detail=None):
        if not self.check(condition, name, detail):
            raise AuditFatal(name)


def money(value):
    if value is None or isinstance(value, bool):
        raise AuditFatal(f'Invalid monetary cell value: {value!r}')
    try:
        result = Decimal(str(value)) * 100
    except InvalidOperation as exc:
        raise AuditFatal(f'Non-numeric monetary cell value: {value!r}') from exc
    if not result.is_finite() or result != result.to_integral_value():
        raise AuditFatal(f'Monetary cell is not exact cents: {value!r}')
    return int(result)


def integer(value):
    result = Decimal(str(value))
    if not result.is_finite() or result != result.to_integral_value():
        raise AuditFatal(f'Non-integer quantity: {value!r}')
    return int(result)


def is_red(cell):
    color = cell.font.color
    return bool(color and ((color.type == 'rgb' and color.rgb[-6:].upper() == 'FF0000')
                           or (color.type == 'indexed' and color.indexed in (2, 10))))


def legal(value):
    if not isinstance(value, str):
        raise AuditFatal(f'Legal entity is not text: {value!r}')
    matches = list(re.finditer(r'(?<![A-Za-z0-9])L\d+(?![A-Za-z0-9])', value))
    if len(matches) != 1:
        raise AuditFatal(f'Legal entity code must be unique: {value!r}')
    match = matches[0]
    start, end = match.span()
    # Remove only a paired wrapper immediately around the code; never company text.
    if start and end < len(value) and (value[start - 1], value[end]) in (
            ('(', ')'), ('（', '）'), ('[', ']'), ('【', '】')):
        start -= 1
        end += 1
    name = (value[:start] + value[end:]).strip()
    if not name:
        raise AuditFatal('Legal entity name is empty')
    return name, match.group()


def key(fields):
    return tuple(legal(fields[k]) if k == 'legal' else fields[k] for k in FIELDS)


def locate(book, aliases, explicit=None):
    found = []
    for sheet in ([book[explicit]] if explicit else book.worksheets):
        for row in sheet.iter_rows(min_row=1, max_row=min(sheet.max_row, 30)):
            columns = {}
            for field, labels in aliases.items():
                matches = [cell.column for cell in row
                           if isinstance(cell.value, str) and cell.value.strip() in labels]
                if len(matches) != 1:
                    break
                columns[field] = matches[0]
            else:
                found.append((sheet, row[0].row, columns))
    if len(found) != 1:
        raise AuditFatal(f'Header must be unique; found {len(found)} for {tuple(aliases)}')
    return found[0]


def load(path):
    return (openpyxl.load_workbook(path, data_only=False),
            openpyxl.load_workbook(path, data_only=True))


def conditional_formatting_on_cost(sheet, column, header_row):
    for conditional in sheet.conditional_formatting:
        for region in conditional.sqref.ranges:
            if region.min_col <= column <= region.max_col and region.max_row > header_row:
                return True
    return False


def fields_at(sheet, row, columns):
    return {field: sheet.cell(row, columns[field]).value for field in FIELDS}


def error_cells(book):
    return {(s.title, cell.coordinate, str(cell.value)) for s in book for row in s for cell in row
            if cell.data_type == 'e' or (isinstance(cell.value, str) and cell.value in ERRORS)}


def audit(args, result, checks):
    meta_path = Path(args.metadata).resolve()
    meta = json.loads(meta_path.read_text(encoding='utf-8-sig'))
    context = (json.loads(Path(args.context).read_text(encoding='utf-8-sig'))
               if args.context else meta.get('context', {}))
    checks.need(all(k in context for k in ('price', 'total', 'quantity')), 'requested_parameters_present')
    price, target, quantity = money(context['price']), money(context['total']), integer(context['quantity'])
    checks.equal(price * quantity, target, 'requested_price_times_quantity')
    plan_path = meta_path.parent / 'plan.json'
    plan = json.loads(plan_path.read_text(encoding='utf-8-sig')) if plan_path.exists() else meta['plan']
    paths = {role: Path(meta['paths'][role]).resolve()
             for role in ('invoice', 'marked', 'remaining', 'audit')}
    inputs = {role: Path(context.get('inputs', {}).get(role) or plan[role]).resolve()
              for role in ('source', 'template')}
    inputs['tax'] = Path(context.get('inputs', {}).get('tax') or
                         next(p for p in plan['input_sha256'] if p not in (str(inputs['source']), str(inputs['template'])))).resolve()
    forbidden = {meta_path, plan_path.resolve(), *inputs.values(), *paths.values(),
                 *(Path(p).resolve() for p in context.get('protected_sha256', {}))}
    if args.context:
        forbidden.add(Path(args.context).resolve())
    if args.report:
        checks.need(Path(args.report).suffix.lower() == '.json' and Path(args.report).resolve() not in forbidden,
                    'report_is_separate_json')
        result['report_path'] = str(Path(args.report).resolve())
    for role, path in {**inputs, **{f'output_{k}': v for k, v in paths.items()}}.items():
        checks.need(path.is_file(), f'file_exists:{role}', str(path))
    checks.need(len(set(paths.values())) == 4, 'four_distinct_output_paths')
    checks.need(not set(inputs.values()).intersection(paths.values()), 'outputs_never_overwrite_inputs')
    before_hashes = {str(path): hashlib.sha256(path.read_bytes()).hexdigest()
                     for path in {*inputs.values(), *paths.values()}}
    result.update({'metadata': str(meta_path), 'outputs': {k: str(v) for k, v in paths.items()},
                   'requested': {'price_cents': price, 'total_cents': target, 'quantity': quantity},
                   'read_only': True})

    srcf, srcv = load(inputs['source'])
    source, sh, sc = locate(srcf, SOURCE, plan.get('source_sheet'))
    checks.need(not conditional_formatting_on_cost(source, sc['amount'], sh),
                'source_cost_column_has_no_unverifiable_conditional_formatting',
                {'sheet': source.title, 'column': sc['amount'], 'header_row': sh})
    source_values = srcv[source.title]
    invf, invv = load(paths['invoice'])
    invoice, ih, ic = locate(invf, INVOICE, plan.get('template_sheet'))
    invoice_values = invv[invoice.title]
    templatef, templatev = load(inputs['template'])
    template, th, tc = locate(templatef, INVOICE, plan.get('template_sheet'))
    taxf, taxv = load(inputs['tax'])
    tax, tax_header, taxcols = locate(taxf, TAX)

    original = {}
    groups = defaultdict(list)
    excluded_incomplete = []
    for row in range(sh + 1, source.max_row + 1):
        value = source_values.cell(row, sc['amount']).value
        if value is None:
            checks.check(all(source.cell(row, c).value is None for c in range(1, source.max_column + 1)),
                         f'source_nonempty_row_without_amount:{row}')
            continue
        amount = money(value)
        checks.check(amount >= 0, f'source_nonnegative:{row}')
        fields = fields_at(source, row, sc)
        original[row] = {'fields': fields, 'amount_cents': amount,
                         'historic_used': is_red(source.cell(row, sc['amount']))}
        if original[row]['historic_used']:
            continue
        if any(fields[field] in (None, '') for field in FIELDS):
            excluded_incomplete.append(row)
            continue
        try:
            group_key = key(fields)
        except AuditFatal:
            continue
        groups[group_key].append(row)

    taxentries = defaultdict(list)
    for row in range(tax_header + 1, tax.max_row + 1):
        code = tax.cell(row, taxcols['code']).value
        if code is not None:
            taxentries[code].append((row, {k: tax.cell(row, col).value for k, col in taxcols.items()}))

    actual_invoice = []
    used_by_group = defaultdict(int)
    tax_kinds = Counter()
    accounts = []
    for row in range(ih + 1, invoice.max_row + 1):
        value = invoice_values.cell(row, ic['amount']).value
        if value is None:
            checks.check(all(invoice.cell(row, col).value is None for col in ic.values()),
                         f'invoice_no_orphan_data:{row}')
            continue
        fields = fields_at(invoice, row, ic)
        checks.need(all(fields[field] not in (None, '') for field in FIELDS),
                    f'invoice_complete_six_fields:{row}')
        group_key = key(fields)
        checks.need(group_key in groups, f'invoice_group_exists_exactly_in_source:{row}', fields)
        checks.check(not used_by_group[group_key], f'invoice_one_row_per_group:{row}')
        used = money(value)
        row_price = money(invoice_values.cell(row, ic['price']).value)
        row_quantity = integer(invoice_values.cell(row, ic['quantity']).value)
        row_total = money(invoice_values.cell(row, ic['total']).value)
        available = sum(original[r]['amount_cents'] for r in groups[group_key])
        checks.equal(row_price, price, f'invoice_unit_price:{row}')
        checks.check(row_quantity > 0, f'invoice_positive_integer_quantity:{row}')
        checks.equal(used, price * row_quantity, f'invoice_amount_equals_price_quantity:{row}')
        checks.equal(row_total, used, f'invoice_total_equals_department_amount:{row}')
        checks.check(0 < used <= available, f'invoice_group_not_overdrawn:{row}')
        remainder = available - used
        checks.check(remainder == 0 or (remainder >= 30000 and remainder % 100 == 0),
                     f'invoice_group_remainder_rule:{row}', remainder)
        checks.check(any(tuple(original[r]['fields'][f] for f in FIELDS) == tuple(fields[f] for f in FIELDS)
                         for r in groups[group_key]), f'invoice_six_fields_preserve_source_original:{row}')
        used_by_group[group_key] += used

        name, code = legal(fields['legal'])
        matches = taxentries.get(code, [])
        checks.need(len(matches) == 1, f'tax_unique_exact_code:{row}:{code}', len(matches))
        taxrow, entry = matches[0]
        checks.equal(entry['name'], name, f'tax_actual_company_name:{row}:{code}')
        checks.check(isinstance(entry['credit'], str) and bool(entry['credit'].strip()) and entry['credit'] != code,
                     f'tax_credit_complete_source_text:{row}:{code}')
        checks.equal(tax.cell(taxrow, taxcols['credit']).data_type, 's',
                     f'tax_credit_source_text_type:{row}:{code}')
        kind = entry['kind']
        tax_kinds[str(kind)] += 1
        actual_text = invoice_values.cell(row, ic['invoice']).value
        if kind in ('小规模纳税人', '一般纳税人-简易征收'):
            expected_text = entry['credit']
            checks.check(isinstance(actual_text, str) and '\n' not in actual_text,
                         f'tax_credit_only_format:{row}:{code}')
        elif kind == '一般纳税人-一般征收':
            for field in ('name', 'credit', 'address', 'bank', 'account'):
                checks.need(isinstance(entry[field], str) and bool(entry[field].strip()),
                            f'tax_required_text:{row}:{code}:{field}')
                checks.equal(tax.cell(taxrow, taxcols[field]).data_type, 's',
                             f'tax_source_text_type:{row}:{code}:{field}')
            expected_text = '\n'.join([entry[f] for f in ('name', 'credit', 'address', 'bank', 'account')] + ['', '专票'])
            checks.check(isinstance(actual_text, str) and len(actual_text.split('\n')) == 7
                         and actual_text.split('\n')[5:] == ['', '专票'],
                         f'tax_seven_line_format:{row}:{code}')
            accounts.append({'invoice_row': row, 'code': code, 'length': len(entry['account'])})
        else:
            checks.check(False, f'tax_known_classification:{row}:{code}', kind)
            expected_text = None
        checks.equal(actual_text, expected_text, f'tax_exact_all_characters:{row}:{code}')
        checks.equal(invoice.cell(row, ic['invoice']).data_type, 's', f'tax_invoice_text_type:{row}')
        checks.equal(invoice.cell(row, ic['invoice']).number_format, '@', f'tax_invoice_text_format:{row}')
        actual_invoice.append({'row': row, 'key': group_key, 'fields': fields,
                               'used_cents': used, 'quantity': row_quantity,
                               'amount_cents': available, 'remainder_cents': remainder,
                               'tax_row': taxrow, 'tax_kind': kind})

    checks.equal(sum(g['used_cents'] for g in actual_invoice), target, 'actual_invoice_amount_sum')
    checks.equal(sum(g['quantity'] for g in actual_invoice), quantity, 'actual_invoice_quantity_sum')
    checks.equal(len(actual_invoice), len(plan['invoice_rows']), 'actual_group_count_matches_plan')
    checks.equal(invoice['A1'].value, template['A1'].value, 'EP_preserved_verbatim')
    checks.equal(invoice['A2'].value, template['A2'].value, 'product_title_preserved')
    checks.equal(invoice['A2'].value, context.get('product', plan.get('product')), 'requested_product')
    checks.equal(money(invoice_values['I2'].value), price, 'invoice_summary_price')
    checks.equal(integer(invoice_values['J2'].value), quantity, 'invoice_summary_quantity')
    checks.equal(money(invoice_values['K2'].value), target, 'invoice_summary_total_cache')
    checks.check(set(str(r) for r in template.merged_cells.ranges).issubset(set(str(r) for r in invoice.merged_cells.ranges)),
                 'template_merges_preserved')
    for actual, planned in zip(actual_invoice, plan['invoice_rows']):
        for field in ('fields', 'amount_cents', 'used_cents', 'quantity', 'remainder_cents'):
            checks.equal(actual[field], planned[field], f'plan_matches_actual:{actual["row"]}:{field}')
        checks.equal(actual['row'], planned['target_row'], f'plan_target_row:{actual["row"]}')
        checks.equal(groups[actual['key']], planned['source_rows'], f'plan_source_rows:{actual["row"]}')
        checks.equal(actual['tax_row'], planned['tax_record']['source_row'], f'plan_tax_source_row:{actual["row"]}')

    draw = {}
    for group_key, used in used_by_group.items():
        left = used
        for row in groups[group_key]:
            take = min(left, original[row]['amount_cents'])
            if take:
                draw[row] = take
                left -= take
        checks.equal(left, 0, f'FIFO_draw_complete:{groups[group_key][0]}')
    expected_marked, expected_remaining = [], []
    for row in range(1, source.max_row + 1):
        if row not in original:
            entries = [{'source_row': row, 'amount_cents': None, 'status': 'header_or_control'}]
        else:
            record = original[row]
            amount, take = record['amount_cents'], draw.get(row, 0)
            if record['historic_used']:
                entries = [{'source_row': row, 'amount_cents': amount, 'status': 'historic_used'}]
            elif take:
                entries = [{'source_row': row, 'amount_cents': take, 'status': 'current_used'}]
                if take < amount:
                    entries.append({'source_row': row, 'amount_cents': amount - take, 'status': 'available'})
            else:
                entries = [{'source_row': row, 'amount_cents': amount, 'status': 'available'}]
        for entry in entries:
            expected_marked.append({**entry, 'target_row': len(expected_marked) + 1})
            if entry['status'] not in ('current_used', 'historic_used'):
                expected_remaining.append({**entry, 'target_row': len(expected_remaining) + 1})

    outputbooks = {'invoice': (invf, invv)}
    totals = {}
    red_counts = {}
    expected_by_role = {'marked': expected_marked, 'remaining': expected_remaining}
    for role, expected in expected_by_role.items():
        bookf, bookv = load(paths[role])
        outputbooks[role] = (bookf, bookv)
        sheet, header, columns = locate(bookf, SOURCE, source.title)
        checks.need(not conditional_formatting_on_cost(sheet, columns['amount'], header),
                    f'{role}_cost_column_has_no_unverifiable_conditional_formatting',
                    {'sheet': sheet.title, 'column': columns['amount'], 'header_row': header})
        values = bookv[sheet.title]
        checks.equal(header, sh, f'{role}_header_row')
        checks.equal(columns, sc, f'{role}_header_columns')
        checks.equal(sheet.max_row, len(expected), f'{role}_row_count')
        checks.equal(meta.get(role + '_mapping'), expected, f'{role}_metadata_mapping_independent')
        total, red_total, count, red_count = 0, 0, 0, 0
        for item in expected:
            outrow, inrow = item['target_row'], item['source_row']
            if outrow <= sh:
                continue
            for col in range(1, source.max_column + 1):
                if col != sc['amount']:
                    checks.equal(sheet.cell(outrow, col).value, source.cell(inrow, col).value,
                                 f'{role}_preserved_record_cell:{outrow}:{col}:source{inrow}')
            if item['amount_cents'] is None:
                checks.equal(values.cell(outrow, sc['amount']).value, None, f'{role}_blank_amount:{outrow}')
                continue
            actual = money(values.cell(outrow, sc['amount']).value)
            checks.equal(actual, item['amount_cents'], f'{role}_exact_split_amount:{outrow}:source{inrow}')
            used_status = item['status'] in ('current_used', 'historic_used')
            checks.equal(is_red(sheet.cell(outrow, sc['amount'])), used_status, f'{role}_red_status:{outrow}')
            checks.equal(sheet.row_dimensions[outrow].height, source.row_dimensions[inrow].height,
                         f'{role}_original_row_height:{outrow}')
            count += 1
            total += actual
            if is_red(sheet.cell(outrow, sc['amount'])):
                red_count += 1
                red_total += actual
        totals[role] = total
        red_counts[role] = {'records': red_count, 'amount_cents': red_total}
        checks.equal(money(values.cell(2, sc['amount']).value), total, f'{role}_amount_formula_cache')
        amount_formula = sheet.cell(2, sc['amount']).value
        letter = openpyxl.utils.get_column_letter(sc['amount'])
        match = re.fullmatch(r'=SUM\(\$?' + letter + r'\$?(\d+):\$?' + letter + r'\$?(\d+)\)', str(amount_formula), re.I)
        checks.check(bool(match) and int(match.group(1)) == sh + 1 and len(expected) <= int(match.group(2)) <= 1048576,
                     f'{role}_sum_formula_correct_range', amount_formula)
        for coordinate in ('C2', 'G2'):
            checks.equal(sheet[coordinate].value, source[coordinate].value, f'{role}_native_control_formula:{coordinate}')
        for coordinate in ('D2', 'I2'):
            checks.equal(sheet[coordinate].value, source[coordinate].value, f'{role}_historical_control_preserved:{coordinate}')
        if source['C2'].value == '=SUM(E2+I2+J2+K2+L2+M2)':
            control_sum = sum(Decimal(str(values.cell(2, col).value or 0)) for col in (5, 9, 10, 11, 12, 13))
            checks.equal(Decimal(str(values['C2'].value)), control_sum, f'{role}_control_C2_cache')
            checks.equal(Decimal(str(values['G2'].value)), Decimal(str(values['D2'].value)) - control_sum,
                         f'{role}_native_IMSUB_cache')
        checks.equal(sheet.freeze_panes, source.freeze_panes, f'{role}_freeze_panes')
        checks.check(bool(sheet.auto_filter.ref) and sheet.auto_filter.ref.endswith(str(len(expected))),
                     f'{role}_filter_covers_output')
        checks.equal(count, sum(x['amount_cents'] is not None for x in expected), f'{role}_amount_record_count')

    source_total = sum(r['amount_cents'] for r in original.values())
    historic = sum(r['amount_cents'] for r in original.values() if r['historic_used'])
    checks.equal(totals['marked'], source_total, 'marked_source_money_conservation')
    checks.equal(red_counts['marked']['amount_cents'], historic + target, 'all_red_equals_history_plus_current')
    checks.equal(red_counts['remaining'], {'records': 0, 'amount_cents': 0}, 'remaining_contains_no_used_red_rows')
    checks.equal(totals['remaining'], source_total - historic - target, 'remaining_conservation')
    checks.equal(totals['remaining'], plan['remaining_total_cents'], 'plan_remaining_matches_actual_cells')
    checks.equal(len(draw), sum(x['status'] == 'current_used' for x in expected_marked), 'current_used_row_count')

    auditf, auditv = load(paths['audit'])
    outputbooks['audit'] = (auditf, auditv)
    required = ('核对汇总', '分组明细', '源行追踪', '异常与文件')
    checks.need(all(name in auditv.sheetnames for name in required), 'audit_required_tabs')
    overview = auditv['核对汇总']
    for cell, expected in {'B5': source_total - historic, 'B6': target, 'B7': totals['remaining']}.items():
        checks.equal(money(overview[cell].value), expected, f'audit_summary:{cell}')
    checks.equal(integer(overview['B8'].value), quantity, 'audit_summary_quantity')
    checks.equal(integer(overview['B9'].value), len(actual_invoice), 'audit_summary_group_count')
    grouped = auditv['分组明细']
    checks.equal(grouped.max_row, len(actual_invoice) + 1, 'audit_group_sheet_row_count')
    for index, group in enumerate(actual_invoice, 2):
        vals = [grouped.cell(index, col).value for col in range(1, 16)]
        f = group['fields']
        expected = [index - 1, f['applicant'], f['department'], f['use_center'], f['cost_center'], f['legal'], f['purpose'],
                    group['amount_cents'] / 100, group['used_cents'] / 100, group['quantity'], group['remainder_cents'] / 100,
                    '、'.join(map(str, groups[group['key']])), group['row'], group['tax_row'], group['tax_kind']]
        checks.equal(vals, expected, f'audit_group_row:{index}')
    used_map = {x['source_row']: x for x in expected_marked if x['status'] == 'current_used'}
    unused_map = {x['source_row']: x for x in expected_remaining if x['status'] == 'available'}
    expected_trace = []
    for index, group in enumerate(actual_invoice, 1):
        for row in groups[group['key']]:
            used, unused = used_map.get(row), unused_map.get(row)
            expected_trace.append([index, group['fields']['applicant'], row, original[row]['amount_cents'] / 100,
                                   used['amount_cents'] / 100 if used else 0,
                                   unused['amount_cents'] / 100 if unused else 0,
                                   used['target_row'] if used else None, unused['target_row'] if unused else None])
    trail = auditv['源行追踪']
    checks.equal(trail.max_row, len(expected_trace) + 1, 'audit_trace_row_count')
    for index, expected in enumerate(expected_trace, 2):
        checks.equal([trail.cell(index, col).value for col in range(1, 9)], expected, f'audit_trace_row:{index}')
    issue_sheet = auditv['异常与文件']
    issue_cells = {str(cell.value) for row in issue_sheet for cell in row if cell.value is not None}
    input_pairs = {(issue_sheet.cell(row, 2).value, issue_sheet.cell(row, 3).value)
                   for row in range(1, issue_sheet.max_row + 1)}
    for path, digest in plan['input_sha256'].items():
        checks.check((path, digest) in input_pairs, f'audit_input_path_hash:{path}')
    for role, path in paths.items():
        checks.check(str(path) in issue_cells, f'audit_output_file_list:{role}')

    formula_counts = {}
    for role, (formulas, values) in outputbooks.items():
        baseline = error_cells(templatev if role == 'invoice' else srcv) if role != 'audit' else set()
        output_errors = error_cells(values)
        checks.check(not output_errors.difference(baseline), f'{role}_no_new_cached_formula_errors',
                     sorted(output_errors.difference(baseline)))
        formulas_count = 0
        for sheet in formulas:
            for row in sheet:
                for cell in row:
                    if cell.data_type != 'f':
                        continue
                    formulas_count += 1
                    cached = values[sheet.title][cell.coordinate]
                    checks.check('#REF!' not in cell.value, f'{role}_formula_no_bad_reference:{sheet.title}!{cell.coordinate}')
                    checks.check(cached.value is not None, f'{role}_formula_has_cache:{sheet.title}!{cell.coordinate}')
        formula_counts[role] = formulas_count

    expected_hashes = {**({} if args.historical else context.get('protected_sha256', {})), **plan['input_sha256']}
    for path, digest in expected_hashes.items():
        checks.equal(hashlib.sha256(Path(path).read_bytes()).hexdigest(), digest, f'protected_hash_unchanged:{path}')
    after_hashes = {path: hashlib.sha256(Path(path).read_bytes()).hexdigest() for path in before_hashes}
    checks.equal(after_hashes, before_hashes, 'audit_did_not_mutate_workbooks')
    result.update({'historical_mode': args.historical, 'actual': {'groups': len(actual_invoice), 'quantity': sum(g['quantity'] for g in actual_invoice),
                              'amount_cents': sum(g['used_cents'] for g in actual_invoice),
                              'original_total_cents': source_total, 'historic_used_cents': historic,
                              'remaining_total_cents': totals['remaining'], 'source_cost_records': len(original),
                              'current_used_records': len(draw),
                              'split_original_records': sum(0 < draw.get(r, 0) < d['amount_cents'] for r, d in original.items()),
                              'marked_total_rows': len(expected_marked), 'remaining_total_rows': len(expected_remaining),
                              'remaining_cost_records': sum(x['amount_cents'] is not None for x in expected_remaining),
                              'incomplete_source_records_retained': len(excluded_incomplete),
                              'incomplete_source_cents_retained': sum(original[r]['amount_cents'] for r in excluded_incomplete)},
                   'tax_classifications_by_invoice_group': dict(tax_kinds),
                   'long_account_checks': [x for x in accounts if x['length'] >= 16],
                   'formula_counts_with_cache_checked': formula_counts,
                   'input_and_output_sha256': after_hashes,
                   'limitations': ['Read-only audit checks saved formula caches and references; native Excel recalculation and visual layout are separate checks.']})


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--legacy-six-exact', action='store_true', required=True,
                        help='Acknowledge this validator only covers the old single-source six-field exact format')
    parser.add_argument('--metadata', required=True, help='Authoring metadata with context, paths, mappings and plan')
    parser.add_argument('--context', help='Optional request context JSON; overrides metadata.context')
    parser.add_argument('--report', help='Optional separate JSON audit report; never a workbook or input path')
    parser.add_argument('--historical', action='store_true',
                        help='Recheck an archived batch after state promotion; still verify snapshot hashes, skip live working-file/index hashes')
    args = parser.parse_args()
    if not args.legacy_six_exact:
        parser.error('This validator is fail-closed for the current department-compatible multi-source rules.')
    checks = Checks()
    result = {'schema_version': 1, 'audit': 'independent_actual_cell_export_audit',
              'checked_at_utc': datetime.now(timezone.utc).isoformat()}
    try:
        audit(args, result, checks)
    except Exception as exc:
        checks.check(False, 'fatal_exception', {'type': type(exc).__name__, 'message': str(exc),
                                               'traceback': traceback.format_exc(limit=4)})
    result.update({'status': 'passed' if checks.failures == 0 else 'failed',
                   'checks_run': checks.count, 'failure_count': checks.failures, 'errors': checks.errors})
    encoded = json.dumps(result, ensure_ascii=False, indent=2)
    # The audit itself performs no workbook or index writes. Its only optional write
    # is the explicitly requested report, after the collision guard inside audit().
    if args.report and result.get('report_path') == str(Path(args.report).resolve()):
        report_path = Path(args.report).resolve()
        if report_path.suffix.lower() == '.json':
            report_path.parent.mkdir(parents=True, exist_ok=True)
            report_path.write_text(encoded, encoding='utf-8')
    print(encoded)
    return 0 if checks.failures == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
