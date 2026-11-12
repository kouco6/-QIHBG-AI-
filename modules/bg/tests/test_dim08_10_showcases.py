import copy
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from server import valid_dim_multi_snapshot, valid_state


class BidShowcaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.seeds = {f'DIM-{number:02d}': json.loads((ROOT / 'dimension-assets' / f'dim{number:02d}-seed.json').read_text(encoding='utf-8')) for number in (8, 9, 10)}

    def test_sample_depth_and_links(self):
        cost, control, bid = (self.seeds[f'DIM-{number:02d}'] for number in (8, 9, 10))
        self.assertEqual((len(cost['competitors']), len(cost['bom'])), (3, 7))
        self.assertEqual(sum(item['count'] * item['unit'] for item in cost['bom']), cost['ownCost'])
        self.assertEqual(len(control['points']), 6)
        self.assertEqual(sum(len(topic['clauses'][brand]) for topic in control['topics'] for brand in '甲乙丙'), 30)
        self.assertTrue(all(point['topic'] in {topic['id'] for topic in control['topics']} for point in control['points']))
        self.assertEqual((len(bid['topics']), len(bid['original'])), (11, 18))
        self.assertEqual({state: sum(row['s'] == state for row in bid['original']) for state in ('full', 'low', 'high', 'none')}, {'full': 11, 'low': 3, 'high': 3, 'none': 1})
        for dimension_id, seed in self.seeds.items():
            self.assertTrue(valid_dim_multi_snapshot(dimension_id, seed))

    def test_content_edits_keep_fixed_architecture(self):
        cost = copy.deepcopy(self.seeds['DIM-08'])
        cost['ownCost'] = 800
        cost['competitors'][0]['price'] = 1500
        self.assertTrue(valid_dim_multi_snapshot('DIM-08', cost))
        cost['competitors'][0]['url'] = 'javascript:alert(1)'
        self.assertFalse(valid_dim_multi_snapshot('DIM-08', cost))

        control = copy.deepcopy(self.seeds['DIM-09'])
        control['topics'][0]['clauses']['甲'][0][1] = '修订后的招标原文'
        control['points'][0]['require'] = '修订后的控标内容'
        self.assertTrue(valid_dim_multi_snapshot('DIM-09', control))
        control['points'][0]['topic'] = 'T99'
        self.assertFalse(valid_dim_multi_snapshot('DIM-09', control))

        bid = copy.deepcopy(self.seeds['DIM-10'])
        bid['original'][0]['s'] = 'low'
        bid['original'][0]['req'] = '修订后的原始条款'
        self.assertTrue(valid_dim_multi_snapshot('DIM-10', bid))
        bid['original'][0]['id'] = 'A99'
        self.assertFalse(valid_dim_multi_snapshot('DIM-10', bid))

    def test_all_three_version_histories_are_append_only(self):
        base = {'projects': [{'id': 'p1', 'name': '验收', 'type': '系统', 'status': 'active'}],
                'bodies': {}, 'cycles': {}, 'history': {}, 'runs': [], 'settings': {}, 'showcases': {}}
        for dimension_id, seed in self.seeds.items():
            first = copy.deepcopy(base)
            first['showcases'] = {'p1': {dimension_id: {'current': copy.deepcopy(seed),
                'versions': [{'id': 'v1', 'label': '原始示例', 'snapshot': copy.deepcopy(seed)}]}}}
            self.assertTrue(valid_state(first, base)[0])
            changed = copy.deepcopy(first)
            current = changed['showcases']['p1'][dimension_id]['current']
            if dimension_id == 'DIM-08':
                current['ownCost'] += 1
            elif dimension_id == 'DIM-09':
                current['points'][0]['title'] += '修订'
            else:
                current['original'][0]['s'] = 'low'
            changed['showcases']['p1'][dimension_id]['versions'].append(
                {'id': 'v2', 'label': '编辑内容', 'snapshot': copy.deepcopy(current)})
            self.assertTrue(valid_state(changed, first)[0])
            rewritten = copy.deepcopy(changed)
            rewritten['showcases']['p1'][dimension_id]['versions'][0]['label'] = '篡改'
            self.assertFalse(valid_state(rewritten, changed)[0])


if __name__ == '__main__':
    unittest.main()
