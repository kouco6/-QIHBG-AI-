#!/usr/bin/env python3
"""Read-only coverage check; never imports a server, saves a project, or calls a model."""
import argparse
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import re
import sys

SKILL = Path(__file__).resolve().parents[1]
ROOT = SKILL.parents[3]
MISSING = object()
STATUSES = {'filled', 'pending', 'not-applicable', 'preserved', 'derived'}
KINDS = {'fact', 'inference', 'recommendation', 'unknown', 'structure', 'derived'}
IDENTITY = ('taskId', 'batchId', 'projectId', 'dimensionId', 'revision', 'parentRevision')


def read_json(path):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('Duplicate JSON key: ' + key)
            result[key] = value
        return result
    return json.loads(Path(path).read_text(encoding='utf-8'), object_pairs_hook=unique,
                      parse_constant=lambda value: (_ for _ in ()).throw(ValueError('Invalid number: ' + value)))


def pointer(parts):
    return '/' + '/'.join(str(p).replace('~', '~0').replace('/', '~1') for p in parts) if parts else ''


def tokens(path):
    return [p.replace('~1', '/').replace('~0', '~') for p in path[1:].split('/')] if path else []


def resolve(snapshot, pattern, optional=False, nullable=()):
    """Return concrete targets, including missing optional values and empty-list patterns."""
    parts = tokens(pattern)
    found, errors = [], []

    def visit(value, rest, at):
        if not rest:
            found.append((pointer(at), value))
            return
        part, tail = rest[0], rest[1:]
        if value is MISSING or value is None:
            if optional or value is None and any(matches(p, pointer(at)) for p in nullable):
                found.append((pointer(at + rest), MISSING))
            else:
                errors.append('Missing structure: ' + pointer(at))
            return
        if part == '*':
            if isinstance(value, dict):
                pairs = list(value.items())
            elif isinstance(value, list):
                pairs = list(enumerate(value))
            else:
                errors.append('Expected collection: ' + pointer(at))
                return
            if not pairs:
                found.append((pointer(at + rest), MISSING))
            for key, item in pairs:
                visit(item, tail, at + [key])
        elif isinstance(value, dict) and part in value:
            visit(value[part], tail, at + [part])
        elif isinstance(value, list) and part.isdigit() and int(part) < len(value):
            visit(value[int(part)], tail, at + [int(part)])
        elif optional:
            found.append((pointer(at + rest), MISSING))
        else:
            errors.append('Missing field: ' + pointer(at + [part]))
    visit(snapshot, parts, [])
    return found, errors


def load_contract(dimension):
    if dimension not in {f'DIM-{i:02d}' for i in range(1, 13)}:
        raise ValueError('Invalid dimensionId')
    path = SKILL / 'references/frontend-fields' / ('dim' + dimension[-2:] + '.json')
    raw = path.read_bytes()
    return json.loads(raw), hashlib.sha256(raw).hexdigest()


def source_errors(contract):
    errors = []
    for source in contract['sources']:
        path = ROOT / source['path']
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != source['sha256']:
            errors.append('Frontend contract drift; re-audit source: ' + source['path'])
    return errors


def expected_targets(contract, snapshot):
    result, errors = {}, []
    for field in contract['fields']:
        targets, issues = resolve(snapshot, field['path'], field.get('optional', False), contract.get('nullableContainers', []))
        errors.extend(issues)
        for path, value in targets:
            result[path] = (value, field)
    return result, errors


def native_valid(dimension, snapshot):
    # Reuse the platform's AST loader: only pure functions, no server top-level execution.
    sys.path.insert(0, str(ROOT / 'scripts'))
    from planning_templates import validators
    checks = validators(ROOT / 'modules/bg')
    try:
        number = int(dimension[-2:])
        if number <= 4:
            return bool(checks[f'valid_dim{number:02d}_snapshot'](snapshot))
        return bool(checks['valid_dim_multi_snapshot'](dimension, snapshot))
    except (TypeError, ValueError, KeyError, IndexError):
        return False


def matches(pattern, actual):
    p, a = tokens(pattern), tokens(actual)
    return len(p) == len(a) and all(x == '*' or x == y for x, y in zip(p, a))


def leaves(value, at=()):
    if isinstance(value, dict):
        for key, item in value.items():
            yield from leaves(item, (*at, key))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from leaves(item, (*at, index))
    else:
        yield pointer(at)


def archive_errors(research, task=None):
    """Check the existing archive contract, not the truth of its contents."""
    errors = []

    def text(value):
        return isinstance(value, str) and bool(value.strip())

    if research.get('status') not in {'completed', 'partial', 'blocked'}:
        errors.append('Invalid research status')
    if not text(research.get('skillVersion')) or not isinstance(research.get('skillSha256'), str) or not re.fullmatch(r'[a-f0-9]{64}', research['skillSha256']):
        errors.append('Missing research skill version/digest')
    if task is not None:
        for key in ('skillVersion', 'skillSha256'):
            if research.get(key) != task.get(key):
                errors.append('Research/task skill mismatch: ' + key)
    scope = research.get('scope')
    if not isinstance(scope, dict) or any(not text(scope.get(key)) for key in ('product', 'market', 'scenario', 'purpose')):
        errors.append('Incomplete research scope')
    required = {
        'findings': ('id', 'question', 'statement', 'kind', 'evidenceIds', 'limitations'),
        'evidence': ('id', 'title', 'publisher', 'urlOrFile', 'publishedAt', 'accessedAt', 'locator', 'applicability', 'verification'),
        'gaps': ('question', 'reason', 'attemptedPaths', 'nextAction'),
        'conflicts': ('topic', 'evidenceIds', 'resolution'),
        'planningImplications': ('recommendation', 'rationale', 'evidenceIds', 'dependencies', 'priorityReason')}
    evidence = {row.get('id') for row in research.get('evidence', [])
                if isinstance(row, dict) and isinstance(row.get('id'), str)} if isinstance(research.get('evidence'), list) else set()
    for section, fields in required.items():
        rows = research.get(section)
        if not isinstance(rows, list):
            errors.append('Missing research array: ' + section)
            continue
        for index, row in enumerate(rows):
            location = section + '/' + str(index)
            if not isinstance(row, dict) or any(key not in row for key in fields):
                errors.append('Incomplete research record: ' + location)
                continue
            for key in fields:
                value = row[key]
                if key in {'evidenceIds', 'attemptedPaths', 'dependencies'}:
                    if not isinstance(value, list) or any(not text(v) for v in value):
                        errors.append('Invalid research list: ' + location + '/' + key)
                    elif key == 'evidenceIds' and any(v not in evidence for v in value):
                        errors.append('Dangling archive evidence: ' + location)
                elif key == 'limitations':
                    if not isinstance(value, str):
                        errors.append('Invalid limitations: ' + location)
                elif not text(value):
                    errors.append('Empty research value: ' + location + '/' + key)
            if section == 'evidence' and row['verification'] not in {'lead', 'verified-public', 'confirmed-internal'}:
                errors.append('Invalid evidence verification: ' + location)
            if section == 'findings' and row['kind'] not in {'fact', 'inference', 'recommendation', 'unknown'}:
                errors.append('Invalid finding kind: ' + location)
    if research.get('status') == 'completed' and not research.get('findings'):
        errors.append('Completed research needs findings')
    if research.get('status') in {'partial', 'blocked'} and not research.get('gaps'):
        errors.append('Partial/blocked research needs explicit gaps')
    return errors


def check(output, research=None, task=None):
    if not isinstance(output, dict) or research is not None and not isinstance(research, dict) or task is not None and not isinstance(task, dict):
        raise ValueError('Output, research and task JSON must be objects')
    errors = []
    dimension = output.get('dimensionId')
    contract, digest = load_contract(dimension)
    errors.extend(source_errors(contract))
    if output.get('schemaVersion') != 'c2c-frontend-v1':
        errors.append('schemaVersion must be c2c-frontend-v1')
    if output.get('fieldContractSha256') != digest:
        errors.append('Field contract digest mismatch')
    for key in IDENTITY:
        if key not in output:
            errors.append('Missing identity: ' + key)
    for key in ('taskId', 'batchId', 'projectId'):
        if not isinstance(output.get(key), str) or not output[key].strip():
            errors.append('Invalid identity: ' + key)
    if type(output.get('revision')) is not int or output['revision'] < 1:
        errors.append('revision must be a positive integer')
    if output.get('parentRevision') is not None and (type(output['parentRevision']) is not int or output['parentRevision'] < 1):
        errors.append('Invalid parentRevision')
    elif type(output.get('revision')) is int:
        parent = output.get('parentRevision')
        if output['revision'] == 1 and parent is not None or output['revision'] > 1 and (parent is None or parent >= output['revision']):
            errors.append('Invalid revision ancestry')
    if research is not None:
        errors.extend(archive_errors(research, task))
        if research.get('schemaVersion') != 'c2c-research-v1':
            errors.append('Research archive schema mismatch')
        for key in IDENTITY:
            if output.get(key) != research.get(key):
                errors.append('Research identity mismatch: ' + key)
    if task is not None:
        for key in IDENTITY:
            if output.get(key) != task.get(key):
                errors.append('Task identity mismatch: ' + key)
        if task.get('fieldContractSha256') != digest:
            errors.append('Task field contract digest mismatch')
        expected_ref = str((SKILL / 'references/frontend-fields' / ('dim' + dimension[-2:] + '.json')).relative_to(ROOT))
        if task.get('fieldContractRef') != expected_ref:
            errors.append('Task field contract reference mismatch')
    evidence_list = research.get('evidence', []) if research is not None else []
    if not isinstance(evidence_list, list):
        errors.append('Research evidence must be an array')
        evidence_list = []
    evidence = {e.get('id'): e for e in evidence_list if isinstance(e, dict) and isinstance(e.get('id'), str)}
    if len(evidence) != len(evidence_list):
        errors.append('Invalid or duplicate evidence IDs in research archive')
    snapshot = output.get('frontendSnapshot')
    if not isinstance(snapshot, dict):
        errors.append('frontendSnapshot must be an object')
        snapshot = {}
    for path, expected in contract.get('requiredValues', {}).items():
        found, issues = resolve(snapshot, path)
        errors.extend(issues)
        if len(found) != 1 or found[0][1] != expected or type(found[0][1]) is not type(expected):
            errors.append('Current format/field definition mismatch: ' + path)
    for container in contract['containers']:
        targets, issues = resolve(snapshot, container['path'], container.get('optional', False), contract.get('nullableContainers', []))
        errors.extend(issues)
        for path, value in targets:
            if value is MISSING or value is None and (container.get('optional') or container['path'] in contract.get('nullableContainers', [])):
                continue
            expected = dict if container['type'] == 'object' else list
            if not isinstance(value, expected):
                errors.append('Invalid collection type: ' + path)
    targets, issues = expected_targets(contract, snapshot)
    errors.extend(issues)
    rows = output.get('fieldCoverage')
    if not isinstance(rows, list):
        rows = []
        errors.append('fieldCoverage must be an array')
    coverage = {}
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get('path'), str):
            errors.append('Invalid coverage entry')
            continue
        path = row['path']
        if path in coverage:
            errors.append('Duplicate coverage path: ' + path)
        coverage[path] = row
    for path in sorted(set(targets) - set(coverage)):
        errors.append('Uncovered field: ' + path)
    for path in sorted(set(coverage) - set(targets)):
        errors.append('Unexpected coverage path: ' + path)
    for path, (value, field) in targets.items():
        row = coverage.get(path)
        if row is None:
            continue
        status, kind, refs = row.get('status'), row.get('kind'), row.get('evidenceIds')
        if status not in STATUSES or kind not in KINDS:
            errors.append('Invalid field status/kind: ' + path)
        if not isinstance(refs, list) or any(not isinstance(e, str) for e in refs):
            errors.append('Invalid evidenceIds: ' + path)
            refs = []
        if research is not None and any(e not in evidence for e in refs):
            errors.append('Dangling evidence reference: ' + path)
        if not isinstance(row.get('reason'), str):
            errors.append('Missing field explanation: ' + path)
        if status in {'pending', 'not-applicable'} and not str(row.get('reason', '')).strip():
            errors.append('Unexplained gap: ' + path)
        allowed = {'research': {'filled', 'pending', 'not-applicable'},
                   'structure': {'preserved', 'pending', 'not-applicable'},
                   'derived': {'derived', 'pending', 'not-applicable'}}
        if status not in allowed[field['role']]:
            errors.append('Status does not match field role: ' + path)
        if status == 'preserved' and kind != 'structure' or status == 'derived' and kind != 'derived':
            errors.append('Invalid structure/derived kind: ' + path)
        if status == 'filled' and kind in {'unknown', 'structure', 'derived'}:
            errors.append('Filled research field has invalid kind: ' + path)
        if field['role'] == 'research' and status == 'filled' and not refs:
            errors.append('Research field needs evidence: ' + path)
        if research is not None and kind == 'fact' and status == 'filled' and not any(
                evidence.get(e, {}).get('verification') in {'verified-public', 'confirmed-internal'} for e in refs):
            errors.append('Fact requires verified evidence: ' + path)
        if status == 'filled' and value in ('待核实', '待内部确认', '待确认', '未知'):
            errors.append('Unknown value counted as complete: ' + path)
        if value is MISSING or value is None or value == '':
            if status not in {'pending', 'not-applicable'}:
                errors.append('Missing value counted as complete: ' + path)
            if value is None and field['role'] == 'structure' and not field.get('optional'):
                errors.append('Required structure cannot be null: ' + path)
        elif not (isinstance(value, str) and 'string' in field['types'] or
                  type(value) is bool and 'boolean' in field['types'] or
                  type(value) in (int, float) and 'number' in field['types']):
            errors.append('Invalid value type: ' + path)
        if type(value) in (int, float) and not math.isfinite(value):
            errors.append('Non-finite number: ' + path)
        if 'enum' in field and value not in (MISSING, None, '') and value not in field['enum']:
            errors.append('Invalid enum: ' + path)
        if dimension == 'DIM-12' and path.startswith('/values/') and path != '/values/15':
            if value == 'pending' and status != 'pending':
                errors.append('Unselected planning decision counted as complete: ' + path)
            if value in ('yes', 'no'):
                if row.get('decisionConfirmed') is not True:
                    errors.append('Planning choice requires human confirmation: ' + path)
                if research is not None and not any(evidence.get(e, {}).get('verification') == 'confirmed-internal' for e in refs):
                    errors.append('Planning choice needs internal decision evidence: ' + path)
        if dimension == 'DIM-12' and path.startswith('/values/'):
            for key in ('recommendation', 'nextAction'):
                if not isinstance(row.get(key), str) or not row[key].strip():
                    errors.append('Missing per-metric ' + key + ': ' + path)
    for path in leaves(snapshot):
        if not any(matches(field['path'], path) for field in contract['fields']):
            # Nullable optional images represent absence of their child resource fields.
            nullable = any(matches(pattern, path) for pattern in contract.get('nullableContainers', []))
            if not nullable:
                errors.append('Field missing from contract; re-audit: ' + path)
    errors.extend(check_links(dimension, snapshot))
    compatible = native_valid(dimension, snapshot)
    return {'valid': not errors, 'dimensionId': dimension, 'coveredFields': len(set(targets) & set(coverage)),
            'expectedFields': len(targets), 'pendingFields': sum(r.get('status') == 'pending' for r in rows if isinstance(r, dict)),
            'snapshotCompatible': compatible, 'publicationChecked': False,
            'evidenceReferencesChecked': research is not None, 'researchArchiveChecked': research is not None,
            'taskChecked': task is not None,
            'errors': sorted(set(errors))}


def check_links(dimension, snapshot):
    errors = []
    try:
        if dimension == 'DIM-01':
            fields = {f['id'] for f in snapshot['fields']}
            slots = {r['id'] + '|' + c['id'] for r in snapshot['rows'] for c in snapshot['cols']}
            for slot, card in snapshot['cards'].items():
                if slot not in slots or card and set(card['values']) != fields:
                    errors.append('Invalid matrix/field binding: ' + slot)
        if dimension == 'DIM-04':
            for row in snapshot['rows']:
                tech = snapshot['analysis'].get(row['id'])
                if not tech or tech['id'] != row['id']:
                    errors.append('Missing technology analysis: ' + row['id'])
            for tech in snapshot['analysis'].values():
                for point in tech['points']:
                    if any(e not in snapshot['evidence'] for e in point['evidence']):
                        errors.append('Dangling technology evidence: ' + point['id'])
        if dimension == 'DIM-05':
            modules = {m['internal_id'] for m in snapshot['inventory']}
            features = {f['internal_id'] for m in snapshot['inventory'] for f in m['features']}
            products = {p['key'] for p in snapshot['scope']['products']}
            for pillar in snapshot['architecture']['pillars']:
                if not set(pillar['module_internal_ids']) <= modules:
                    errors.append('Dangling architecture module')
            for module in snapshot['inventory']:
                if module['feature_count'] != len(module['features']):
                    errors.append('Incorrect feature_count: ' + module['internal_id'])
                for feature in module['features']:
                    if feature['module_internal_id'] != module['internal_id'] or set(feature['products']) != products:
                        errors.append('Invalid feature/module/product binding: ' + feature['internal_id'])
            for item in snapshot['highlight_features'] + snapshot['comparisons']:
                if not set(item['linked_feature_ids']) <= features:
                    errors.append('Dangling linked feature')
            stats = snapshot['stats']
            if (stats['module_count'] != len(modules) or stats['researched_feature_count'] != len(features)
                    or stats['product_family_count'] != len(products)):
                errors.append('Incorrect function statistics')
            for product in products:
                counts = Counter(feature['products'][product]['ability_state']
                                 for module in snapshot['inventory'] for feature in module['features'])
                reported = stats['status_count_by_product'].get(product, {})
                if any(reported.get(state, 0) != count for state, count in counts.items()) or any(
                        count != counts.get(state, 0) for state, count in reported.items()):
                    errors.append('Incorrect product state statistics: ' + product)
        if dimension == 'DIM-09':
            topics = {t['id'] for t in snapshot['topics']}
            if any(p['topic'] not in topics for p in snapshot['points']):
                errors.append('Dangling control point topic')
        if dimension == 'DIM-10':
            topics = {t['id'] for t in snapshot['topics']}
            if any(r['t'] not in topics or r['b'] not in {'A', 'B', 'C'} for r in snapshot['original']):
                errors.append('Invalid tender topic/brand binding')
        if dimension == 'DIM-12':
            if len(snapshot['values']) != len(snapshot['fields']) or len(snapshot['fields']) != 18:
                errors.append('Planning matrix must cover all 18 fields')
    except (KeyError, TypeError, IndexError):
        errors.append('Incomplete relational structure')
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', nargs='?', help='c2c-frontend-v1 JSON')
    parser.add_argument('--research', help='paired c2c-research-v1 JSON (evidence reference check)')
    parser.add_argument('--task', help='immutable task JSON (identity check)')
    parser.add_argument('--describe', metavar='DIM-01', help='print this dimension contract and its digest')
    parser.add_argument('--require-compatible', action='store_true', help='also fail if existing draft snapshot validator rejects it')
    args = parser.parse_args()
    try:
        if args.describe:
            contract, digest = load_contract(args.describe)
            print(json.dumps({'fieldContractSha256': digest, 'contract': contract, 'sourceErrors': source_errors(contract)}, ensure_ascii=False, indent=2))
            return int(bool(source_errors(contract)))
        if not args.output:
            parser.error('output or --describe is required')
        report = check(read_json(args.output), read_json(args.research) if args.research else None,
                       read_json(args.task) if args.task else None)
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return int(not report['valid'] or args.require_compatible and not report['snapshotCompatible'])
    except (ValueError, OSError, TypeError, KeyError) as error:
        print(json.dumps({'valid': False, 'errors': [str(error)]}, ensure_ascii=False))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
