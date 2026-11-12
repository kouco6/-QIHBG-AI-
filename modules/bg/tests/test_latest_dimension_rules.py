import copy
import json
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from server import valid_dim01_snapshot, valid_dim03_snapshot, valid_dim_multi_snapshot, valid_state


def base_state():
    return {'projects': [{'id': 'p1', 'name': '验收', 'type': '系统', 'status': 'active'}],
            'bodies': {}, 'cycles': {}, 'history': {}, 'runs': [], 'settings': {}, 'showcases': {}}


class LatestDimensionRulesTests(unittest.TestCase):
    def test_dim01_v7_promotes_matching_draft_without_rewriting_its_snapshot(self):
        html = (ROOT / 'dimension-assets' / 'dim01-v7.html').read_text()
        original = json.loads(re.search(r'const INITIAL_DATA=(\{[^\n]+\});', html)[1])
        draft = copy.deepcopy(original)
        card = next(iter(draft['cards'].values()))
        card['title'] = '已编辑的企划卡片'
        self.assertTrue(valid_dim01_snapshot(draft, release=True))
        old = base_state()
        old['showcases']['p1'] = {'DIM-01': {
            'current': original, 'draft': draft, 'applied': True,
            'versions': [{'id': 'v1', 'kind': 'applied', 'snapshot': copy.deepcopy(original)},
                         {'id': 'v2', 'kind': 'draft', 'label': '保存草稿', 'snapshot': copy.deepcopy(draft)}],
        }}
        applied = copy.deepcopy(old)
        store = applied['showcases']['p1']['DIM-01']
        store['current'] = store.pop('draft')
        store['versions'][-1].update(kind='applied', label='保存并应用', appliedAt='2026-11-10T00:00:00Z')
        self.assertTrue(valid_state(applied, old)[0])
        next(iter(store['versions'][-1]['snapshot']['cards'].values()))['title'] = '修改了历史快照'
        store['current'] = copy.deepcopy(store['versions'][-1]['snapshot'])
        self.assertFalse(valid_state(applied, old)[0])

    def test_dim03_v5_draft_and_atomic_application(self):
        row = {'id': 'cert1', 'name': '示例资质', 'grade': '行业', 'expiry': '长期有效',
               'owned': '是', 'difficulty': '低', 'barrier': '中'}
        formal = {'format': 'v5', 'rows': [row]}
        self.assertTrue(valid_dim03_snapshot(formal))
        old = base_state()
        first = copy.deepcopy(old)
        first['showcases']['p1'] = {'DIM-03': {'current': formal, 'versions': [
            {'id': 'v1', 'kind': 'applied', 'label': '保存并应用', 'snapshot': copy.deepcopy(formal)}]}}
        self.assertTrue(valid_state(first, old)[0])
        draft = copy.deepcopy(first)
        draft['showcases']['p1']['DIM-03']['draft'] = copy.deepcopy(formal)
        draft['showcases']['p1']['DIM-03']['draft']['rows'][0]['owned'] = ''
        self.assertTrue(valid_state(draft, first)[0])
        failed = copy.deepcopy(draft)
        item = failed['showcases']['p1']['DIM-03']
        item['current'] = copy.deepcopy(item['draft'])
        item['versions'].append({'id': 'v2', 'kind': 'applied', 'label': '保存并应用', 'snapshot': copy.deepcopy(item['current'])})
        self.assertFalse(valid_state(failed, draft)[0])

    def test_dim06_eight_columns_and_required_fields(self):
        row = {'id': 'r1', 'category': '无线传输', 'product': '会议麦克风', 'function': '无线发言',
               'functional': '语音连续', 'design': '延迟≤30ms', 'test': '记录测试条件',
               'competitor': '', 'experience': ''}
        formal = {'format': 'v5', 'widths': [9, 12, 10, 14, 15, 17, 12, 11], 'rows': [row], 'merges': []}
        self.assertTrue(valid_dim_multi_snapshot('DIM-06', formal))
        old = base_state()
        first = copy.deepcopy(old)
        first['showcases']['p1'] = {'DIM-06': {'current': formal, 'versions': [
            {'id': 'v1', 'kind': 'applied', 'label': '保存并应用', 'snapshot': copy.deepcopy(formal)}]}}
        self.assertTrue(valid_state(first, old)[0])
        incomplete = copy.deepcopy(first)
        item = incomplete['showcases']['p1']['DIM-06']
        item['current']['rows'][0]['product'] = ''
        item['versions'].append({'id': 'v2', 'kind': 'applied', 'label': '保存并应用', 'snapshot': copy.deepcopy(item['current'])})
        self.assertFalse(valid_state(incomplete, first)[0])

    def test_dim12_unselected_cannot_be_applied(self):
        seed = json.loads((ROOT / 'dimension-assets' / 'dim12-seed.json').read_text())
        self.assertTrue(valid_dim_multi_snapshot('DIM-12', seed))
        old = base_state()
        first = copy.deepcopy(old)
        first['showcases']['p1'] = {'DIM-12': {'current': seed, 'versions': [
            {'id': 'v1', 'label': '原始示例', 'snapshot': copy.deepcopy(seed)}], 'applied': False}}
        self.assertTrue(valid_state(first, old)[0])
        failed = copy.deepcopy(first)
        item = failed['showcases']['p1']['DIM-12']
        item['versions'].append({'id': 'v2', 'kind': 'applied', 'label': '保存并应用', 'snapshot': copy.deepcopy(seed)})
        self.assertFalse(valid_state(failed, first)[0])
        completed = copy.deepcopy(first)
        item = completed['showcases']['p1']['DIM-12']
        item['current'] = copy.deepcopy(seed)
        item['current']['values'] = ['yes' if value == 'pending' else value for value in seed['values']]
        item['versions'].append({'id': 'v2', 'kind': 'applied', 'label': '保存并应用', 'snapshot': copy.deepcopy(item['current'])})
        item['applied'] = True
        self.assertTrue(valid_state(completed, first)[0])


if __name__ == '__main__':
    unittest.main()
