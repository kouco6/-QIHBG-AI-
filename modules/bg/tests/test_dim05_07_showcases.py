import copy
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from server import valid_dim_multi_snapshot, valid_state


class MultiShowcaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.seeds = {f'DIM-{n:02d}': json.loads((ROOT / 'dimension-assets' / f'dim{n:02d}-seed.json').read_text(encoding='utf-8')) for n in (5, 6, 7)}

    def test_sample_content_and_fixed_fields(self):
        dim05, dim06, dim07 = (self.seeds[f'DIM-{n:02d}'] for n in (5, 6, 7))
        self.assertEqual((len(dim05['inventory']), sum(len(m['features']) for m in dim05['inventory']), len(dim05['highlight_features']), len(dim05['comparisons'])), (10, 50, 5, 8))
        self.assertEqual((len(dim06['fields']), len(dim06['rows'])), (7, 10))
        self.assertEqual((len(dim07['fields']), len(dim07['rows'])), (6, 18))
        for dimension_id, seed in self.seeds.items():
            self.assertTrue(valid_dim_multi_snapshot(dimension_id, seed))

    def test_body_values_editable_but_architecture_is_fixed(self):
        sample05 = copy.deepcopy(self.seeds['DIM-05'])
        sample05['inventory'][0]['features'][0]['products']['pro']['detail'] = '修订后的产品条件'
        self.assertTrue(valid_dim_multi_snapshot('DIM-05', sample05))
        sample05['architecture']['pillars'][0]['title'] = '被改动的架构字段'
        self.assertFalse(valid_dim_multi_snapshot('DIM-05', sample05))

        sample06 = copy.deepcopy(self.seeds['DIM-06'])
        sample06['rows'][0]['design'] = '修订后的设计指标'
        self.assertTrue(valid_dim_multi_snapshot('DIM-06', sample06))
        sample06['fields'][0] = '被改动的字段名'
        self.assertFalse(valid_dim_multi_snapshot('DIM-06', sample06))

        sample07 = copy.deepcopy(self.seeds['DIM-07'])
        sample07['rows'][0]['可行性'] = '修订后的可行性说明'
        self.assertTrue(valid_dim_multi_snapshot('DIM-07', sample07))
        sample07['rows'].pop()
        self.assertFalse(valid_dim_multi_snapshot('DIM-07', sample07))

    def test_versions_append_only_for_all_three_dimensions(self):
        base = {'projects': [{'id': 'p1', 'name': '验收', 'type': '系统', 'status': 'active'}],
                'bodies': {}, 'cycles': {}, 'history': {}, 'runs': [], 'settings': {}, 'showcases': {}}
        for dimension_id, seed in self.seeds.items():
            first = copy.deepcopy(base)
            first['showcases'] = {'p1': {dimension_id: {'current': copy.deepcopy(seed),
                'versions': [{'id': 'v1', 'label': '原始示例', 'snapshot': copy.deepcopy(seed)}]}}}
            self.assertTrue(valid_state(first, base)[0])
            changed = copy.deepcopy(first)
            value = changed['showcases']['p1'][dimension_id]['current']
            if dimension_id == 'DIM-05':
                value['inventory'][0]['features'][0]['feature_name'] = '修订功能名称'
            elif dimension_id == 'DIM-06':
                value['rows'][0]['design'] = '修订设计指标'
            else:
                value['rows'][0]['AI功能名称'] = '修订 AI 功能名称'
            changed['showcases']['p1'][dimension_id]['versions'].append(
                {'id': 'v2', 'label': '编辑内容', 'snapshot': copy.deepcopy(value)})
            self.assertTrue(valid_state(changed, first)[0])
            rewritten = copy.deepcopy(changed)
            rewritten['showcases']['p1'][dimension_id]['versions'][0]['label'] = '篡改旧版本'
            self.assertFalse(valid_state(rewritten, changed)[0])


if __name__ == '__main__':
    unittest.main()
