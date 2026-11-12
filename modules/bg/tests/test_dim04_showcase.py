import copy
import json
import unittest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from server import valid_dim04_snapshot, valid_state


class Dim04ShowcaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.seed = json.loads((ROOT / 'dimension-assets' / 'dim04-seed.json').read_text(encoding='utf-8'))

    def test_three_topics_keep_seven_sections_and_evidence_links(self):
        self.assertTrue(valid_dim04_snapshot(self.seed))
        self.assertEqual([len(topic['recommendations']) for topic in self.seed['topics']], [3, 2, 3])
        altered = copy.deepcopy(self.seed)
        altered['topics'][0]['benchmark'][0]['evidenceId'] = 'ptp-e-01'
        self.assertFalse(valid_dim04_snapshot(altered))
        altered = copy.deepcopy(self.seed)
        altered['topics'][0]['evidence'].pop()
        self.assertFalse(valid_dim04_snapshot(altered))

    def test_edited_content_requires_append_only_version(self):
        base = {'projects': [{'id': 'p1', 'name': '验收', 'type': '系统', 'status': 'active'}],
                'bodies': {}, 'cycles': {}, 'history': {}, 'runs': [], 'settings': {}, 'showcases': {}}
        first = copy.deepcopy(base)
        first['showcases'] = {'p1': {'DIM-04': {'current': copy.deepcopy(self.seed),
            'versions': [{'id': 'v1', 'label': '原始示例', 'snapshot': copy.deepcopy(self.seed)}]}}}
        self.assertTrue(valid_state(first, base)[0])
        changed = copy.deepcopy(first)
        topic = changed['showcases']['p1']['DIM-04']['current']['topics'][0]
        topic['sections'][0]['paragraphs'][0] = '已编辑的技术说明。'
        changed['showcases']['p1']['DIM-04']['versions'].append(
            {'id': 'v2', 'label': '编辑技术分析正文', 'snapshot': copy.deepcopy(changed['showcases']['p1']['DIM-04']['current'])})
        self.assertTrue(valid_state(changed, first)[0])
        rewritten = copy.deepcopy(changed)
        rewritten['showcases']['p1']['DIM-04']['versions'][0]['snapshot']['topics'][0]['title'] = '被改写的旧版本'
        self.assertFalse(valid_state(rewritten, changed)[0])


if __name__ == '__main__':
    unittest.main()
