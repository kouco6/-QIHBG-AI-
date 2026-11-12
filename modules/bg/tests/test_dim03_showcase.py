import copy
import json
import unittest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from server import valid_dim03_snapshot, valid_state


class Dim03ShowcaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source = json.loads((ROOT / 'dimension-assets' / 'dim03-seed.json').read_text(encoding='utf-8'))
        cls.seed = {'groups': source['groups']}

    def test_sample_keeps_three_groups_and_twenty_cards_with_six_fields(self):
        self.assertTrue(valid_dim03_snapshot(self.seed))
        self.assertEqual([len(group['items']) for group in self.seed['groups']], [8, 6, 6])
        changed = copy.deepcopy(self.seed)
        changed['groups'][0]['items'][0]['公司是否拥有'] = '待核实'
        self.assertTrue(valid_dim03_snapshot(changed))
        del changed['groups'][0]['items'][0]['行业门槛']
        self.assertFalse(valid_dim03_snapshot(changed))

    def test_history_can_be_deleted_without_changing_applied_content(self):
        base = {'projects': [{'id': 'p1', 'name': '验收', 'type': '系统', 'status': 'active'}],
                'bodies': {}, 'cycles': {}, 'history': {}, 'runs': [], 'settings': {}, 'showcases': {}}
        first = copy.deepcopy(base)
        first['showcases'] = {'p1': {'DIM-03': {'current': copy.deepcopy(self.seed),
            'versions': [{'id': 'v1', 'label': '原始示例', 'snapshot': copy.deepcopy(self.seed)}]}}}
        self.assertTrue(valid_state(first, base)[0])
        changed = copy.deepcopy(first)
        item = changed['showcases']['p1']['DIM-03']['current']['groups'][0]['items'][0]
        item['公司是否拥有'] = '待核实'
        changed['showcases']['p1']['DIM-03']['versions'].append(
            {'id': 'v2', 'label': '编辑资质条目', 'snapshot': copy.deepcopy(changed['showcases']['p1']['DIM-03']['current'])})
        self.assertTrue(valid_state(changed, first)[0])
        removed = copy.deepcopy(changed)
        removed['showcases']['p1']['DIM-03']['versions'].pop(0)
        self.assertTrue(valid_state(removed, changed)[0])
        self.assertEqual(removed['showcases']['p1']['DIM-03']['current'], changed['showcases']['p1']['DIM-03']['current'])
        removed = copy.deepcopy(changed)
        del removed['showcases']['p1']['DIM-03']
        self.assertFalse(valid_state(removed, changed)[0])


if __name__ == '__main__':
    unittest.main()
