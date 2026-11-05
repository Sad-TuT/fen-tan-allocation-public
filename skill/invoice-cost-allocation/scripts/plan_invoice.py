#!/usr/bin/env python3
"""Read Excel inputs and produce an exact, auditable invoice allocation plan."""
import argparse
from collections import defaultdict, deque
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
import hashlib
import json
from math import gcd
from pathlib import Path
import re

import openpyxl

SOURCE = {
    'applicant': ('申领人',), 'department': ('申领部门',),
    'use_center': ('使用中心', '使用部门'), 'cost_center': ('成本中心',),
    'amount': ('成本', '可用金额', '剩余金额', '金额'),
    'legal': ('费用承担法律主体',), 'purpose': ('申领用途',),
}
TEMPLATE = {**{k: v for k, v in SOURCE.items() if k != 'amount'},
    'amount': ('部门使用金额',), 'invoice': ('开票明细',),
    'price': ('单价',), 'quantity': ('数量',), 'total': ('总计金额',)}
TAX = {'code': ('法律主体编码',), 'name': ('实际主体名称',), 'kind': ('当前主体类型',),
       'credit': ('社会统一信用代码', '统一社会信用代码'), 'address': ('注册地址',),
       'bank': ('开户行',), 'account': ('银行基本户账号',)}
FIELDS = ('applicant', 'department', 'use_center', 'cost_center', 'legal', 'purpose')


class PlanningError(ValueError):
    pass


def cents(value):
    if isinstance(value, bool) or value is None:
        raise PlanningError(f'Invalid monetary value: {value!r}')
    try:
        money = Decimal(str(value).replace(',', '').strip())
    except InvalidOperation as exc:
        raise PlanningError(f'Invalid monetary value: {value!r}') from exc
    scaled = money * 100
    if not money.is_finite() or scaled != scaled.to_integral_value():
        raise PlanningError(f'Money must have at most two decimal places: {value!r}')
    return int(scaled)


def yuan(value):
    return str(Decimal(value) / 100)


def legal_parts(value):
    if not isinstance(value, str):
        raise PlanningError('Missing legal entity')
    codes = re.findall(r'(?<![A-Za-z0-9])L\d{6}(?![A-Za-z0-9])', value)
    if len(codes) != 1:
        raise PlanningError(f'Expected exactly one legal entity code: {value!r}')
    code = codes[0]
    left, right = value.split(code, 1)
    left, right = left.strip(), right.strip()
    pairs = (('(', ')'), ('（', '）'), ('[', ']'), ('【', '】'))

    def balanced(name):
        expected = []
        opening = {left: right for left, right in pairs}
        closing = {right: left for left, right in pairs}
        for char in name:
            if char in opening:
                expected.append(opening[char])
            elif char in closing:
                if not expected or expected.pop() != char:
                    return False
        return bool(name) and not expected

    names = []
    for opening, closing in pairs:
        if left.endswith(opening) and right.startswith(closing):
            name = left[:-len(opening)].strip() + right[len(closing):].strip()
            if balanced(name):
                names.append(name)
        if not left and right.startswith(opening) and right.endswith(closing):
            name = right[len(opening):-len(closing)].strip()
            if balanced(name):
                names.append(name)
    if not names:
        if not left and right and balanced(right):
            names.append(right)
        elif left and not right and balanced(left):
            names.append(left)
    names = list(dict.fromkeys(names))
    if len(names) != 1:
        raise PlanningError(f'Legal entity name/code layout is unbalanced or has text on both sides: {value!r}')
    return names[0], code


def red(cell):
    color = cell.font.color
    return bool(color and ((color.type == 'rgb' and color.rgb[-6:].upper() == 'FF0000')
                          or (color.type == 'indexed' and color.indexed in (2, 10))))


def summary_row(fields, formula):
    labels = {'合计', '总计', '小计', '总合计', 'total', 'grand total'}
    missing = any(value is None or value == '' for value in fields.values())
    named = any(isinstance(fields[key], str) and fields[key].strip().lower() in labels
                for key in ('applicant', 'department', 'use_center', 'cost_center'))
    blank_formula = all(value is None or value == '' for value in fields.values()) and isinstance(formula, str) and re.match(r'^=(?:SUM|SUBTOTAL|AGGREGATE)\(', formula, re.I)
    return missing and (named or bool(blank_formula))


def locate(book, schema, sheet_name=None):
    choices = [book[sheet_name]] if sheet_name else book.worksheets
    found = []
    for sheet in choices:
        for row in sheet.iter_rows(min_row=1, max_row=min(30, sheet.max_row)):
            columns = {}
            ambiguous = False
            for field, aliases in schema.items():
                hits = [cell.column for cell in row if isinstance(cell.value, str)
                        and cell.value.strip() in aliases]
                if len(hits) != 1:
                    ambiguous = True
                    break
                columns[field] = hits[0]
            if not ambiguous:
                found.append((sheet, row[0].row, columns))
    if len(found) != 1:
        raise PlanningError(f'Expected one unambiguous header, found {len(found)}; specify sheet or confirm columns')
    return found[0]


def legal_options(amount, price, limit):
    """Partial quantities form one arithmetic progression; full use is separate."""
    step = 100 // gcd(price, 100)
    first = next((q for q in range(1, step + 1) if (amount - q * price) % 100 == 0), None)
    maximum = min(limit, (amount - 30000) // price)
    partial = (first, first + ((maximum - first) // step) * step, step) if first is not None and maximum >= first else None
    full = amount // price if amount > 0 and amount % price == 0 and amount // price <= limit else None
    return partial, full


def allocate(groups, price, quantity):
    """Exact minimum-group DP with sliding windows, using immutable backpointers."""
    candidates = []
    for group in groups:
        partial, full = legal_options(group['amount_cents'], price, quantity)
        capacity = max(partial[1] if partial else 0, full or 0)
        if capacity:
            candidates.append((capacity, group, partial, full))
    candidates.sort(key=lambda item: item[1]['source_rows'][0])
    capacity_sum = 0
    lower_bound = None
    for count, capacity in enumerate(sorted((item[0] for item in candidates), reverse=True), 1):
        capacity_sum += capacity
        if lower_bound is None and capacity_sum >= quantity:
            lower_bound = count
    if lower_bound is None:
        raise PlanningError(f'Insufficient legally usable capacity: {capacity_sum} items; need {quantity}')
    dp = [None] * (quantity + 1)
    dp[0] = (0, None)
    for index, (_, group, partial, full) in enumerate(candidates):
        updated = dp.copy()
        if partial:
            qmin, qmax, step = partial
            for residue in range(min(step, quantity + 1)):
                window = deque()
                for target in range(residue, quantity + 1, step):
                    prior = target - qmin
                    if prior >= 0 and dp[prior] is not None:
                        while window and dp[window[-1]][0] > dp[prior][0]:
                            window.pop()
                        window.append(prior)
                    while window and window[0] < target - qmax:
                        window.popleft()
                    if window:
                        prior = window[0]
                        count = dp[prior][0] + 1
                        if updated[target] is None or count < updated[target][0]:
                            updated[target] = (count, (index, target - prior, dp[prior][1]))
        if full:
            for target in range(full, quantity + 1):
                prior = target - full
                if dp[prior] is not None:
                    count = dp[prior][0] + 1
                    if updated[target] is None or count < updated[target][0]:
                        updated[target] = (count, (index, full, dp[prior][1]))
        dp = updated
        if dp[quantity] is not None and dp[quantity][0] == lower_bound:
            break
    if dp[quantity] is None:
        raise PlanningError('No exact allocation satisfies the price and group-remainder rules')
    selected = []
    node = dp[quantity][1]
    while node is not None:
        index, count, node = node
        group = candidates[index][1]
        used = count * price
        remainder = group['amount_cents'] - used
        if not (remainder == 0 or (remainder >= 30000 and remainder % 100 == 0)):
            raise PlanningError('Internal remainder invariant failed')
        selected.append({**group, 'quantity': count, 'used_cents': used, 'remainder_cents': remainder})
    selected.sort(key=lambda group: group['source_rows'][0])
    return selected


def load_tax(filename, sheet_name=None):
    book = openpyxl.load_workbook(filename, data_only=False)
    sheet, header, columns = locate(book, TAX, sheet_name)
    entries = defaultdict(list)
    for row in range(header + 1, sheet.max_row + 1):
        code = sheet.cell(row, columns['code']).value
        if code is None:
            continue
        entry = {key: sheet.cell(row, column).value for key, column in columns.items()}
        entry.update(source_sheet=sheet.title, source_row=row)
        entries[code].append(entry)
    return entries


def load_tax_overrides(filename):
    try:
        parsed = json.loads(Path(filename).read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError) as exc:
        raise PlanningError(f'cannot read tax override JSON: {exc}') from exc
    entities = parsed.get('entities') if isinstance(parsed, dict) else None
    if not isinstance(entities, dict) or not entities:
        raise PlanningError('tax override JSON must contain a non-empty entities object')
    allowed = {'name', 'kind', 'credit', 'address', 'bank', 'account'}
    for code, item in entities.items():
        if not re.fullmatch(r'[A-Za-z]\d{6}', code):
            raise PlanningError(f'{code}: invalid legal entity code in tax override')
        if not isinstance(item, dict):
            raise PlanningError(f'{code}: tax override must be an object')
        if item.get('confirmed_by_user') is not True or not isinstance(item.get('reason'), str) or not item['reason'].strip():
            raise PlanningError(f'{code}: tax override requires user confirmation and reason')
        scope = item.get('scope') if isinstance(item.get('scope'), dict) else {}
        for key in ('applies_to_all_future_batches', 'batch_ids', 'effective_from_utc'):
            if key in item and key in scope:
                raise PlanningError(f'{code}: tax override {key} is declared both at top level and in scope')
        future = item.get('applies_to_all_future_batches') is True or scope.get('applies_to_all_future_batches') is True
        raw_batch_ids = item['batch_ids'] if 'batch_ids' in item else scope.get('batch_ids')
        if raw_batch_ids is not None and (
                not isinstance(raw_batch_ids, list)
                or any(not isinstance(value, str) or not value.strip() for value in raw_batch_ids)):
            raise PlanningError(f'{code}: batch_ids must be a list of non-empty strings')
        batch_ids = [value.strip() for value in raw_batch_ids] if isinstance(raw_batch_ids, list) else []
        if len(batch_ids) != len(set(batch_ids)):
            raise PlanningError(f'{code}: batch_ids must not contain duplicates')
        if future and batch_ids:
            raise PlanningError(f'{code}: tax override cannot combine batch_ids with a future-batch authorization')
        if not future and not batch_ids:
            raise PlanningError(f'{code}: tax override must name applicable batch_ids or authorize all future batches')
        if future:
            raw_effective = item['effective_from_utc'] if 'effective_from_utc' in item else scope.get('effective_from_utc')
            try:
                effective = datetime.fromisoformat(str(raw_effective).replace('Z', '+00:00'))
                if effective.tzinfo is None:
                    raise ValueError('timezone required')
            except (TypeError, ValueError) as exc:
                raise PlanningError(f'{code}: future-batch override needs a timezone-aware effective_from_utc') from exc
        corrections = [key for key in allowed if item.get(key) is not None]
        if not corrections:
            raise PlanningError(f'{code}: tax override has no correction fields')
        for key in corrections:
            if not isinstance(item[key], str) or not item[key].strip():
                raise PlanningError(f'{code}: tax override field {key} must be non-empty text')
    return entities


def override_applies(override, batch_id, batch_created_at=None):
    scope = override.get('scope') if isinstance(override.get('scope'), dict) else {}
    if override.get('applies_to_all_future_batches') is True or scope.get('applies_to_all_future_batches') is True:
        raw_effective = override.get('effective_from_utc', scope.get('effective_from_utc'))
        if not batch_created_at:
            return False
        try:
            effective = datetime.fromisoformat(str(raw_effective).replace('Z', '+00:00'))
            created = datetime.fromisoformat(str(batch_created_at).replace('Z', '+00:00'))
            if effective.tzinfo is None or created.tzinfo is None:
                return False
            return created.astimezone(timezone.utc) >= effective.astimezone(timezone.utc)
        except (TypeError, ValueError):
            return False
    batch_ids = override.get('batch_ids', scope.get('batch_ids'))
    return isinstance(batch_ids, list) and batch_id in batch_ids


def invoice_text(legal, entries, overrides=None, batch_id=None, batch_created_at=None):
    name, code = legal_parts(legal)
    matches = entries.get(code, [])
    if len(matches) != 1:
        raise PlanningError(f'{code}: expected one exact tax record, found {len(matches)}')
    entry = matches[0].copy()
    override = (overrides or {}).get(code)
    if override:
        if not override.get('confirmed_by_user') or not override.get('reason'):
            raise PlanningError(f'{code}: tax overrides require user confirmation and reason')
        if not override_applies(override, batch_id, batch_created_at):
            raise PlanningError(f'{code}: tax override is not authorized for batch {batch_id!r}')
        for key, value in override.items():
            if key in TAX and key != 'code':
                entry[key] = value
    if entry['name'] != name:
        raise PlanningError(f'{code}: company names disagree: {name!r} / {entry["name"]!r}')
    credit = entry['credit']
    if not isinstance(credit, str) or not credit.strip():
        raise PlanningError(f'{code}: credit code must be complete source text')
    issues = []
    if credit == code:
        issues.append('credit-code field duplicates the legal entity code; verify the actual tax ID')
    kinds = ('小规模纳税人', '一般纳税人-简易征收', '一般纳税人-一般征收')
    if entry['kind'] not in kinds:
        issues.append(f'unknown taxpayer classification {entry["kind"]!r}')
    if issues:
        raise PlanningError(f'{code}: ' + '; '.join(issues))
    if entry['kind'] in ('小规模纳税人', '一般纳税人-简易征收'):
        return credit, entry
    for key in ('name', 'address', 'bank', 'account'):
        if not isinstance(entry[key], str) or not entry[key].strip():
            raise PlanningError(f'{code}: {key} must be complete source text; do not infer account digits')
    # Highlight a demonstrated transposed character, without silently repairing it.
    if not override and entry['address'].endswith(' 行') and entry['bank'].endswith('支'):
        raise PlanningError(f'{code}: address/bank character placement needs user confirmation')
    return '\n'.join([entry['name'], credit, entry['address'], entry['bank'], entry['account'], '', '专票']), entry


def make_plan(args):
    price, total = cents(args.price), cents(args.total)
    if price <= 0 or total <= 0 or total % price:
        raise PlanningError('Positive exact total must be an integer multiple of unit price')
    quantity = total // price
    if quantity > 20000:
        raise PlanningError('Quantity exceeds this helper limit; use an exact solver, not a rounded substitute')
    source_book = openpyxl.load_workbook(args.source, data_only=False)
    source_values = openpyxl.load_workbook(args.source, data_only=True)
    source, source_header, source_cols = locate(source_book, SOURCE, args.source_sheet)
    for conditional in source.conditional_formatting:
        if any(region.min_col <= source_cols['amount'] <= region.max_col
               and region.max_row > source_header for region in conditional.sqref.ranges):
            raise PlanningError('Cost-column conditional formatting may encode used status; confirm its meaning before planning')
    value_sheet = source_values[source.title]
    template_book = openpyxl.load_workbook(args.template, data_only=False)
    template, template_header, template_cols = locate(template_book, TEMPLATE, args.template_sheet)
    groups = {}
    records = []
    warnings = []
    for row in range(source_header + 1, source.max_row + 1):
        original = source.cell(row, source_cols['amount'])
        value = value_sheet.cell(row, source_cols['amount']).value
        fields = {key: source.cell(row, source_cols[key]).value for key in FIELDS}
        if summary_row(fields, original.value):
            warnings.append(f'{source.title}!{row}: summary/control row; not counted as an expense record')
            continue
        if value is None and original.value is None:
            continue
        if value is None and original.data_type == 'f':
            raise PlanningError(f'{source.title}!{original.coordinate}: missing cached amount')
        amount = cents(value)
        if amount < 0:
            raise PlanningError(f'{source.title}!{original.coordinate}: negative cost requires an explicit handling rule')
        used_before = red(original)
        record = {'source_row': row, 'fields': fields, 'amount_cents': amount, 'historic_used': used_before}
        records.append(record)
        if used_before:
            continue
        if any(fields[key] is None or fields[key] == '' for key in FIELDS):
            warnings.append(f'{source.title}!{row}: missing grouping fields; retain, exclude from allocation')
            continue
        try:
            legal_name, code = legal_parts(fields['legal'])
        except PlanningError as exc:
            warnings.append(f'{source.title}!{row}: {exc}; retain, exclude from allocation')
            continue
        key = tuple((legal_name, code) if field == 'legal' else fields[field] for field in FIELDS)
        if key not in groups:
            groups[key] = {'fields': fields, 'source_rows': [], 'amount_cents': 0}
        groups[key]['source_rows'].append(row)
        groups[key]['amount_cents'] += amount
    tax_entries = load_tax(args.tax, args.tax_sheet) if args.tax else None
    overrides = load_tax_overrides(args.tax_overrides) if args.tax_overrides else {}
    tax_exclusions = []
    candidates = list(groups.values())
    if args.require_tax_complete:
        if tax_entries is None:
            raise PlanningError('--require-tax-complete needs a tax table')
        verified = []
        for group in candidates:
            partial, full = legal_options(group['amount_cents'], price, quantity)
            if not partial and not full:
                continue
            try:
                invoice_text(group['fields']['legal'], tax_entries, overrides, args.batch_id, args.batch_created_at)
                verified.append(group)
            except PlanningError as exc:
                name, code = legal_parts(group['fields']['legal'])
                matches = tax_entries.get(code, [])
                tax_exclusions.append({'code': code, 'name': name, 'reason': str(exc),
                    'source_rows': group['source_rows'], 'amount_cents': group['amount_cents'],
                    'tax_source_row': matches[0]['source_row'] if len(matches) == 1 else None})
        candidates = verified
    selected = allocate(candidates, price, quantity)
    tax_issues = []
    invoice_rows = []
    draw = {}
    by_row = {record['source_row']: record for record in records}
    for offset, group in enumerate(selected, 1):
        text = None
        tax_record = None
        if tax_entries is not None:
            try:
                text, tax_record = invoice_text(group['fields']['legal'], tax_entries, overrides, args.batch_id, args.batch_created_at)
            except PlanningError as exc:
                tax_issues.append(str(exc))
        else:
            tax_issues.append('Tax table not supplied; invoice details remain pending')
        invoice_rows.append({**group, 'target_row': template_header + offset, 'price_cents': price,
                             'invoice_text': text, 'tax_record': tax_record})
        remaining = group['used_cents']
        for row in group['source_rows']:
            take = min(remaining, by_row[row]['amount_cents'])
            if take:
                draw[row] = take
                remaining -= take
        if remaining:
            raise PlanningError('Internal source-draw invariant failed')
    source_rows = []
    for record in records:
        row, amount = record['source_row'], record['amount_cents']
        take = draw.get(row, 0)
        if record['historic_used']:
            source_rows.append({**record, 'status': 'historic_used'})
        elif take:
            source_rows.append({**record, 'amount_cents': take, 'status': 'current_used'})
            if take < amount:
                source_rows.append({**record, 'amount_cents': amount - take, 'status': 'available'})
        else:
            source_rows.append({**record, 'status': 'available'})
    original_total = sum(record['amount_cents'] for record in records)
    historic_total = sum(row['amount_cents'] for row in source_rows if row['status'] == 'historic_used')
    remaining_total = sum(row['amount_cents'] for row in source_rows if row['status'] == 'available')
    assert sum(row['amount_cents'] for row in source_rows if row['status'] == 'current_used') == total
    assert original_total == historic_total + total + remaining_total
    files = [args.source, args.template] + ([args.tax] if args.tax else [])
    return {'schema_version': 1, 'product': args.product, 'price_cents': price, 'total_cents': total,
        'quantity': quantity, 'source': str(Path(args.source).resolve()), 'template': str(Path(args.template).resolve()),
        'source_sheet': source.title, 'source_header': source_header, 'source_columns': source_cols,
        'template_sheet': template.title, 'template_header': template_header, 'template_columns': template_cols,
        'original_total_cents': original_total, 'historic_used_cents': historic_total,
        'available_before_cents': original_total - historic_total, 'remaining_total_cents': remaining_total,
        'invoice_rows': invoice_rows, 'source_rows': source_rows,
        'warnings': warnings, 'tax_issues': sorted(set(tax_issues)), 'tax_exclusions': tax_exclusions,
        'input_sha256': {str(Path(p).resolve()): hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in files}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--legacy-six-exact', action='store_true', required=True,
                        help='Acknowledge this helper only supports the old single-source six-field exact rule')
    for name in ('source', 'template', 'price', 'total', 'product', 'out'):
        parser.add_argument('--' + name, required=True)
    for name in ('tax', 'source-sheet', 'template-sheet', 'tax-sheet', 'tax-overrides'):
        parser.add_argument('--' + name)
    parser.add_argument('--batch-id', help='Required with --tax-overrides; exact batch scope to apply')
    parser.add_argument('--batch-created-at',
                        help='Required with --tax-overrides; timezone-aware ISO timestamp used for future-scope overrides')
    parser.add_argument('--require-tax-complete', action='store_true',
                        help='For a new allocation, use only price-feasible groups with complete verified tax data')
    args = parser.parse_args()
    if not args.legacy_six_exact:
        parser.error('This helper is fail-closed for the current department-compatible multi-source rules.')
    if args.tax_overrides and not args.batch_id:
        parser.error('--batch-id is required with --tax-overrides so corrections cannot leak across batches')
    if args.tax_overrides and not args.batch_created_at:
        parser.error('--batch-created-at is required with --tax-overrides so future scopes have a verifiable start')
    if args.batch_created_at:
        try:
            created_at = datetime.fromisoformat(args.batch_created_at.replace('Z', '+00:00'))
            if created_at.tzinfo is None:
                raise ValueError('timezone required')
        except ValueError:
            parser.error('--batch-created-at must be a timezone-aware ISO timestamp')
    output = Path(args.out)
    inputs = [args.source, args.template, args.tax, args.tax_overrides]
    if output.suffix.lower() != '.json' or output.resolve() in {Path(p).resolve() for p in inputs if p}:
        parser.error('--out must be a separate .json planning file, never an input file')
    try:
        plan = make_plan(args)
    except (PlanningError, OSError, KeyError) as exc:
        parser.exit(2, f'Cannot produce an exact allocation plan: {exc}\n')
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'plan': str(output.resolve()), 'groups': len(plan['invoice_rows']),
        'quantity': plan['quantity'], 'total': yuan(plan['total_cents']),
        'remaining': yuan(plan['remaining_total_cents']), 'tax_issues': plan['tax_issues'],
        'tax_excluded_groups': len(plan['tax_exclusions']), 'warnings': len(plan['warnings'])}, ensure_ascii=False))


if __name__ == '__main__':
    main()
