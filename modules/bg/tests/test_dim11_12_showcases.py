import copy
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from server import valid_dim_multi_snapshot, valid_state


class FinalShowcaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.appearance = json.loads((ROOT / 'dimension-assets/dim11-seed.json').read_text(encoding='utf-8'))
        cls.experience = json.loads((ROOT / 'dimension-assets/dim12-seed.json').read_text(encoding='utf-8'))

    def test_source_architecture_and_sample_depth(self):
        self.assertEqual(len(self.appearance['products']), 6)
        self.assertTrue(all(len(p['fields']) == 4 and p['svg'].startswith('<svg') for p in self.appearance['products']))
        self.assertEqual([f['label'] for f in self.appearance['products'][0]['fields']],
                         ['设计定位', '设计风格', '应用环境', '核心设计语言'])
        self.assertEqual([g['count'] for g in self.experience['groups']], [11, 3, 2, 2])
        self.assertEqual([c['count'] for c in self.experience['categories']], [4, 7, 3, 2, 2])
        self.assertEqual(len(self.experience['fields']), 18)
        self.assertEqual([f['type'] for f in self.experience['fields']].count('text'), 1)
        self.assertTrue(valid_dim_multi_snapshot('DIM-11', self.appearance))
        self.assertTrue(valid_dim_multi_snapshot('DIM-12', self.experience))

    def test_editable_values_do_not_change_fixed_fields(self):
        appearance = copy.deepcopy(self.appearance)
        appearance['products'][0]['name'] = '修订后的竞品名称'
        appearance['products'][0]['fields'][0]['value'] = '修订后的设计定位'
        appearance['products'][0]['imageUrl'] = 'https://example.com/appearance.png'
        self.assertTrue(valid_dim_multi_snapshot('DIM-11', appearance))
        appearance['products'][0]['fields'][0]['label'] = '新字段'
        self.assertFalse(valid_dim_multi_snapshot('DIM-11', appearance))
        appearance['products'][0]['fields'][0]['label'] = '设计定位'
        appearance['products'][0]['imageUrl'] = 'javascript:alert(1)'
        self.assertFalse(valid_dim_multi_snapshot('DIM-11', appearance))

        experience = copy.deepcopy(self.experience)
        experience['product'] = '新产品名称'
        experience['values'][0] = 'no'
        experience['values'][15] = '自定义文字'
        self.assertTrue(valid_dim_multi_snapshot('DIM-12', experience))
        experience['values'][0] = '不合法状态'
        self.assertFalse(valid_dim_multi_snapshot('DIM-12', experience))
        experience['values'][0] = 'no'
        experience['fields'][0]['label'] = '新指标'
        self.assertFalse(valid_dim_multi_snapshot('DIM-12', experience))

    def test_versions_append_and_current_tracks_latest(self):
        base = {'projects': [{'id': 'p1', 'name': '验收', 'type': '系统', 'status': 'active'}],
                'bodies': {}, 'cycles': {}, 'history': {}, 'runs': [], 'settings': {}, 'showcases': {}}
        for dimension_id, seed in [('DIM-11', self.appearance), ('DIM-12', self.experience)]:
            first = copy.deepcopy(base)
            first['showcases'] = {'p1': {dimension_id: {'current': copy.deepcopy(seed),
                'versions': [{'id': 'v1', 'label': '原始示例', 'snapshot': copy.deepcopy(seed)}]}}}
            self.assertTrue(valid_state(first, base)[0])
            changed = copy.deepcopy(first)
            item = changed['showcases']['p1'][dimension_id]
            if dimension_id == 'DIM-11':
                item['current']['products'][0]['name'] = '第二版'
            else:
                item['current']['values'][17] = 'yes'
            item['versions'].append({'id': 'v2', 'label': '编辑', 'snapshot': copy.deepcopy(item['current'])})
            self.assertTrue(valid_state(changed, first)[0])
            rewritten = copy.deepcopy(changed)
            rewritten['showcases']['p1'][dimension_id]['versions'][0]['label'] = '篡改'
            self.assertFalse(valid_state(rewritten, first)[0])
            mismatch = copy.deepcopy(changed)
            mismatch['showcases']['p1'][dimension_id]['current'] = copy.deepcopy(seed)
            self.assertFalse(valid_state(mismatch, first)[0])


if __name__ == '__main__':
    unittest.main()
