import json
import sqlite3
import tempfile
import unittest
import urllib.request
from pathlib import Path
from unittest.mock import patch
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import round1_poc as poc
from round1_service import Round1Error, Round1Service
from server import valid_state


class Round1IntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.db = self.root / 'test.sqlite3'
        self.state = {'projects': [{'id': 'prj-1', 'name': '测试产品', 'type': '单品', 'status': 'active'}],
                      'bodies': {}, 'cycles': {'prj-1|DIM-01': [{
                          'id': 'cyc-1', 'projectId': 'prj-1', 'dimensionId': 'DIM-01',
                          'ordinal': 1, 'locked': False, 'stage': 0, 'taskVersions': []}]},
                      'history': {}, 'runs': [], 'settings': {}}
        with sqlite3.connect(self.db) as db:
            db.execute('CREATE TABLE app_state (id INTEGER PRIMARY KEY, revision INTEGER, value TEXT)')
            db.execute('INSERT INTO app_state VALUES (1,0,?)', (json.dumps(self.state),))
        self.service = Round1Service(self.db, self.root)

    def tearDown(self):
        self.temp.cleanup()

    def prepare(self, replan=False):
        return self.service.prepare('prj-1', 'DIM-01', 'cyc-1', replan)

    def write_valid_md(self, run):
        meta = {'project_id': 'prj-1', 'dimension_id': 'DIM-01', 'research_cycle_id': 'cyc-1',
                'run_id': run['runId'], 'document_type': 'research_task_package'}
        front = '---\n' + ''.join(f'{k}: {v}\n' for k, v in meta.items()) + '---\n'
        body = '\n'.join([
            '## 研究目标\n形成可验证的产品线覆盖研究规划。' * 3,
            '## 研究边界\n只讨论当前产品及其所属产品线，不提前给出结论。' * 3,
            '## GPT研究任务\nTask-01 调查产品线结构、官方目录和型号证据。\nTask-02 对比竞品产品带、覆盖缺口和证据限制。' * 4,
            '## GPT成果章节结构\n第一章 产品线结构与证据清单；第二章 竞品覆盖与缺口。每章记录来源、日期、引用位置和未找到的信息。',
            '## 任务与章节映射\nTask-01 → 第一章；Task-02 → 第二章；每个任务都要有证据和待核实点。',
            '## 前置依赖\nTask-01 与 Task-02 可以并行；第二章汇总时必须先核对第一章定义的产品线边界。',
            '## 证据与检索要求\n官方目录优先，其次招投标原文；记录 URL、查询日期、引用位置，缺失时说明。',
        ])
        output = Path(run['runDir']) / '正式研究任务包.md'
        output.write_text(front + body, encoding='utf-8')
        return output

    def test_prepare_is_idempotent_and_does_not_fabricate_md(self):
        a = self.prepare()['run']
        b = self.prepare()['run']
        self.assertEqual(a['runId'], b['runId'])
        self.assertTrue(Path(a['runDir'], 'WorkBuddy执行指令.md').is_file())
        self.assertFalse(a['outputExists'])
        self.assertEqual(self.service.check(a['runId'])['run']['state'], 'PREPARED')

    def test_wrong_dimension_rejected(self):
        with self.assertRaisesRegex(Round1Error, 'DIM-01'):
            self.service.prepare('prj-1', 'DIM-02', 'cyc-1')

    def test_file_and_operator_evidence_required_for_publication(self):
        run = self.prepare()['run']
        with self.assertRaisesRegex(Round1Error, '核验'):
            self.service.evidence(run['runId'], 'WorkBuddy会话记录123456')
        output = self.write_valid_md(run)
        checked = self.service.check(run['runId'])['run']
        self.assertEqual(checked['state'], 'STRUCTURE_VALID')
        with self.assertRaisesRegex(Round1Error, '双 Skill'):
            self.service.promote(run['runId'])
        self.service.evidence(run['runId'], 'WorkBuddy 会话 123：两项 Skill 在执行日志中显示实际调用')
        output.write_text(output.read_text() + '\n后续内容', encoding='utf-8')
        with self.assertRaisesRegex(Round1Error, '变化'):
            self.service.promote(run['runId'])
        self.assertIsNone(self.service.check(run['runId'])['run']['evidenceNote'])
        self.service.evidence(run['runId'], 'WorkBuddy 会话 123：更新后再次核对两项 Skill 加载日志')
        promoted = self.service.promote(run['runId'])
        self.assertEqual(promoted['run']['state'], 'OFFICIAL_READY')
        self.assertEqual(promoted['run']['packageVersion'], 1)
        self.assertEqual(promoted['revision'], 1)
        self.assertEqual(len(promoted['state']['cycles']['prj-1|DIM-01'][0]['taskVersions']), 1)
        self.assertEqual(self.service.promote(run['runId'])['run']['packageVersion'], 1)
        self.assertEqual(len(self.prepare()['run']['instruction']) > 0, True)

    def test_replan_keeps_old_version_and_gpt_lock(self):
        run = self.prepare()['run']
        self.write_valid_md(run)
        self.service.check(run['runId'])
        self.service.evidence(run['runId'], 'WorkBuddy 会话 123：专业与公共 Skill 均实际加载')
        self.service.promote(run['runId'])
        new = self.prepare(replan=True)['run']
        self.assertNotEqual(run['runId'], new['runId'])
        with sqlite3.connect(self.db) as db:
            state = json.loads(db.execute('SELECT value FROM app_state WHERE id=1').fetchone()[0])
            state['cycles']['prj-1|DIM-01'][0]['locked'] = True
            db.execute('UPDATE app_state SET revision=revision+1,value=? WHERE id=1', (json.dumps(state),))
        with self.assertRaisesRegex(Round1Error, 'GPT'):
            self.prepare(replan=True)

    def test_frontend_cannot_forge_official_package(self):
        forged = json.loads(json.dumps(self.state))
        forged['cycles']['prj-1|DIM-01'][0]['taskVersions'].append({'version': 1, 'text': 'fake'})
        self.assertFalse(valid_state(forged, self.state)[0])

    def test_mismatched_metadata_and_missing_section_rejected(self):
        run = self.prepare()['run']
        output = self.write_valid_md(run)
        output.write_text(output.read_text().replace('dimension_id: DIM-01', 'dimension_id: DIM-02'))
        self.assertFalse(self.service.check(run['runId'])['run']['validation']['valid_structure'])
        output.write_text(output.read_text().replace('dimension_id: DIM-02', 'dimension_id: DIM-01').replace('## 任务与章节映射', '## 缺失映射'))
        self.assertFalse(self.service.check(run['runId'])['run']['validation']['valid_structure'])

    def test_official_api_receipt_does_not_publish_package(self):
        class FakeResponse:
            def __init__(self, data):
                self.data = data
            def __enter__(self):
                return self
            def __exit__(self, *args):
                pass
            def read(self, _):
                return json.dumps(self.data).encode()
        run = self.prepare()['run']
        requests = []
        def fake_urlopen(request, timeout):
            requests.append((request.full_url, request.get_method(), request.data))
            data = {'online': True} if request.get_method() == 'GET' else {'message_id': 'msg-123'}
            return FakeResponse({'code': 0, 'msg': 'success', 'data': data})
        with patch.dict('os.environ', {'WORKBUDDY_ACCESS_TOKEN': 'test-token'}), patch.object(urllib.request, 'urlopen', side_effect=fake_urlopen):
            sent = self.service.send(run['runId'])
        self.assertEqual(sent['run']['state'], 'SENT')
        self.assertFalse(sent['run']['outputExists'])
        self.assertEqual(json.loads(requests[1][2])['msg_type'], 'text')
        self.assertIn('/openapi/v2/localassistant/message', requests[1][0])


if __name__ == '__main__':
    unittest.main()
