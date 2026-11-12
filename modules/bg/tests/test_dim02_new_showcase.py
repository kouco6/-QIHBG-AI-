import copy
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from server import valid_dim02_v1_snapshot, valid_dim02_v1_release, valid_state


def snapshot():
    return {
        'largeName': '核电站', 'largeImage': '',
        'systems': [{'id': 'sys1', 'name': '公共广播系统', 'devices': [
            {'id': 'dev1', 'name': '网络广播终端', 'status': 'planned', 'image': ''}]}],
        'scenes': [{'id': 'scene1', 'name': '主控室', 'topology': '',
                    'features': [{'id': 'f1', 'name': '高可靠值守', 'description': '全天候监测'}],
                    'needs': [{'id': 'n1', 'name': '多系统联动', 'description': '及时告警'}],
                    'pains': [{'id': 'p1', 'name': '信息分散', 'description': '人工判断慢'}],
                    'goals': [{'id': 'g1', 'text': '建立告警分级机制'}]}]}


class Dim02NewShowcaseTests(unittest.TestCase):
    def test_draft_allows_incomplete_scene_but_release_requires_topology(self):
        draft = snapshot()
        self.assertTrue(valid_dim02_v1_snapshot(draft))
        self.assertFalse(valid_dim02_v1_release(draft))
        draft['scenes'][0]['topology'] = 'data:image/png;base64,iVBORw0KGgo='
        self.assertTrue(valid_dim02_v1_release(draft))
        draft['scenes'][0]['features'][0]['name'] = ''
        self.assertTrue(valid_dim02_v1_snapshot(draft))
        self.assertFalse(valid_dim02_v1_release(draft))

    def test_bad_image_status_and_duplicate_ids_are_rejected(self):
        value = snapshot()
        value['systems'][0]['devices'][0]['status'] = 'unknown'
        self.assertFalse(valid_dim02_v1_snapshot(value))
        value = snapshot()
        value['largeImage'] = 'javascript:alert(1)'
        self.assertFalse(valid_dim02_v1_snapshot(value))
        value = snapshot()
        value['scenes'][0]['id'] = 'sys1'
        self.assertFalse(valid_dim02_v1_snapshot(value))

    def test_draft_preserves_formal_version_and_application_appends(self):
        base = {'projects': [{'id': 'p1', 'name': '验收', 'type': '系统', 'status': 'active'}],
                'bodies': {}, 'cycles': {}, 'history': {}, 'runs': [], 'settings': {}, 'showcases': {}}
        first = copy.deepcopy(base)
        first['showcases']['p1'] = {'DIM-02': {'current': snapshot(), 'versions': [
            {'id': 'v1', 'label': '原始示例', 'snapshot': snapshot()}]}}
        self.assertTrue(valid_state(first, base)[0])
        working = copy.deepcopy(first)
        working['showcases']['p1']['DIM-02']['draft'] = snapshot()
        working['showcases']['p1']['DIM-02']['draft']['largeName'] = '新的大场景'
        self.assertTrue(valid_state(working, first)[0])
        self.assertEqual(working['showcases']['p1']['DIM-02']['current']['largeName'], '核电站')
        release = copy.deepcopy(working)
        item = release['showcases']['p1']['DIM-02']
        item['draft']['scenes'][0]['topology'] = 'data:image/png;base64,iVBORw0KGgo='
        item['current'] = copy.deepcopy(item['draft'])
        item['versions'].append({'id': 'v2', 'label': '保存并应用', 'snapshot': copy.deepcopy(item['current'])})
        self.assertTrue(valid_state(release, working)[0])
        invalid = copy.deepcopy(release)
        invalid['showcases']['p1']['DIM-02']['versions'].pop(0)
        self.assertTrue(valid_state(invalid, release)[0])
        self.assertEqual(invalid['showcases']['p1']['DIM-02']['current'], release['showcases']['p1']['DIM-02']['current'])
        tampered = copy.deepcopy(release)
        tampered['showcases']['p1']['DIM-02']['versions'][0]['snapshot']['largeName'] = '偷改历史'
        self.assertFalse(valid_state(tampered, release)[0])

    def test_independent_chapter_enablement(self):
        value = snapshot()
        value['enabled'] = {'large': False, 'scenes': True}
        self.assertTrue(valid_dim02_v1_snapshot(value))
        value['scenes'][0]['topology'] = 'data:image/png;base64,iVBORw0KGgo='
        self.assertTrue(valid_dim02_v1_release(value))
        value['enabled'] = {'large': False, 'scenes': False}
        self.assertFalse(valid_dim02_v1_release(value))


if __name__ == '__main__':
    unittest.main()
