"""First-round WorkBuddy handoff and publication for DIM-01.

WorkBuddy messages and files are separate evidence. Only a validated file plus an
explicit operator skill check can become an official task package.
"""
import hashlib
import json
import os
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import URLError

import round1_poc as poc


class Round1Error(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def timestamp():
    return datetime.now(timezone.utc).isoformat()


class Round1Service:
    def __init__(self, db_path, root, lock=None):
        self.db_path = Path(db_path)
        self.root = Path(root).resolve()
        self.run_root = self.root / 'round1_runs'
        self.lock = lock or threading.RLock()

    def db(self):
        db = sqlite3.connect(self.db_path)
        db.execute('PRAGMA journal_mode=WAL')
        db.row_factory = sqlite3.Row
        db.execute('''CREATE TABLE IF NOT EXISTS round1_runs (
            run_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, dimension_id TEXT NOT NULL,
            cycle_id TEXT NOT NULL, state TEXT NOT NULL, run_dir TEXT NOT NULL,
            created_at TEXT NOT NULL, message_id TEXT, evidence_note TEXT,
            evidence_at TEXT, validation_json TEXT, package_hash TEXT,
            package_version INTEGER)''')
        db.execute('''CREATE TABLE IF NOT EXISTS round1_packages (
            run_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, dimension_id TEXT NOT NULL,
            cycle_id TEXT NOT NULL, version INTEGER NOT NULL, sha256 TEXT NOT NULL,
            markdown TEXT NOT NULL, created_at TEXT NOT NULL,
            UNIQUE(cycle_id, version))''')
        db.commit()
        return db

    def _cycle(self, state, project_id, dimension_id, cycle_id, require_current=True):
        project = next((p for p in state['projects'] if p['id'] == project_id), None)
        if not project or project.get('status') != 'active':
            raise Round1Error('项目不存在或已归档', 404)
        if dimension_id != 'DIM-01':
            raise Round1Error('目前仅 DIM-01 有样例专业 Skill；其他维度不能借用它', 422)
        cycles = state['cycles'].get(project_id + '|' + dimension_id) or []
        cycle = next((c for c in cycles if c['id'] == cycle_id), None)
        if not cycle:
            raise Round1Error('研究周期不存在', 404)
        if require_current and (cycles[-1]['id'] != cycle_id or cycle.get('locked')):
            raise Round1Error('历史周期或 GPT 已启动的周期不能规划任务', 409)
        return project, cycle

    def _run(self, db, run_id):
        row = db.execute('SELECT * FROM round1_runs WHERE run_id=?', (run_id,)).fetchone()
        if not row:
            raise Round1Error('第一轮运行记录不存在', 404)
        return row

    def recover_interrupted_sends(self):
        # A stopped process cannot know whether a remote POST happened.
        with self.lock, self.db() as db:
            db.execute("UPDATE round1_runs SET state='UNKNOWN' WHERE state='SENDING'")
            db.commit()

    def _safe_dir(self, row):
        directory = Path(row['run_dir']).resolve()
        if not directory.is_relative_to(self.run_root.resolve()):
            raise Round1Error('运行目录超出受控根目录', 403)
        if directory.name != row['run_id']:
            raise Round1Error('运行目录与 runId 不匹配', 403)
        return directory

    def prepare(self, project_id, dimension_id, cycle_id, replan=False):
        with self.lock, self.db() as db:
            revision, raw = db.execute('SELECT revision,value FROM app_state WHERE id=1').fetchone()
            state = json.loads(raw)
            project, cycle = self._cycle(state, project_id, dimension_id, cycle_id)
            existing = db.execute('''SELECT * FROM round1_runs WHERE project_id=? AND dimension_id=? AND cycle_id=?
                ORDER BY created_at DESC, rowid DESC LIMIT 1''', (project_id, dimension_id, cycle_id)).fetchone()
            if existing and existing['state'] != 'OFFICIAL_READY':
                return self.status(existing['run_id'])
            if existing and existing['state'] == 'OFFICIAL_READY' and not replan:
                return self.status(existing['run_id'])
            if replan and not cycle.get('taskVersions'):
                raise Round1Error('当前尚无正式任务包，无需重新规划', 409)
            if not replan and cycle.get('taskVersions'):
                raise Round1Error('已有正式任务包；需要重新规划请使用专用入口', 409)
            run_dir = poc.prepare(self.run_root, project_id, dimension_id, cycle_id, project['name'], project['type'])
            run = poc.load_json(run_dir / 'run.json')
            db.execute('''INSERT INTO round1_runs(run_id,project_id,dimension_id,cycle_id,state,run_dir,created_at)
                VALUES(?,?,?,?,?,?,?)''', (run['run_id'], project_id, dimension_id, cycle_id,
                'PREPARED', str(run_dir), run['created_at']))
            db.commit()
            return self.status(run['run_id'])

    def status(self, run_id=None, cycle_id=None, project_id=None, dimension_id=None):
        with self.lock, self.db() as db:
            if run_id:
                row = self._run(db, run_id)
            elif cycle_id:
                if not project_id or not dimension_id:
                    raise Round1Error('按周期查询还需 projectId 与 dimensionId')
                row = db.execute('''SELECT * FROM round1_runs WHERE project_id=? AND dimension_id=? AND cycle_id=?
                    ORDER BY created_at DESC, rowid DESC LIMIT 1''', (project_id, dimension_id, cycle_id)).fetchone()
                if not row:
                    return {'run': None, 'api_available': bool(os.environ.get('WORKBUDDY_ACCESS_TOKEN'))}
            else:
                raise Round1Error('需要 runId 或 cycleId')
            run_dir = self._safe_dir(row)
            output = run_dir / '正式研究任务包.md'
            instruction = (run_dir / 'WorkBuddy执行指令.md').read_text(encoding='utf-8')
            validation = json.loads(row['validation_json']) if row['validation_json'] else None
            observation_file = run_dir / 'message_observation.json'
            observation = poc.load_json(observation_file) if observation_file.is_file() else None
            return {'run': {'runId': row['run_id'], 'projectId': row['project_id'],
                'dimensionId': row['dimension_id'], 'cycleId': row['cycle_id'],
                'state': row['state'], 'runDir': str(run_dir), 'createdAt': row['created_at'],
                'messageId': row['message_id'], 'outputExists': output.is_file() and not output.is_symlink(),
                'instruction': instruction, 'validation': validation,
                'messageObservation': observation,
                'evidenceNote': row['evidence_note'], 'evidenceAt': row['evidence_at'],
                'packageHash': row['package_hash'], 'packageVersion': row['package_version']},
                'api_available': bool(os.environ.get('WORKBUDDY_ACCESS_TOKEN'))}

    def check(self, run_id):
        with self.lock, self.db() as db:
            row = self._run(db, run_id)
            run_dir = self._safe_dir(row)
            output = run_dir / '正式研究任务包.md'
            if output.is_symlink() or (output.exists() and output.stat().st_size > 2_000_000):
                raise Round1Error('输出文件不能是符号链接，且不得超过 2MB', 422)
            report = poc.validate(run_dir)
            state = row['state']
            if state != 'OFFICIAL_READY':
                state = ('STRUCTURE_VALID' if report['valid_structure'] else
                         'VALIDATION_FAILED' if output.exists() else state)
                old_report = json.loads(row['validation_json'] or '{}')
                evidence_changed = old_report.get('file_sha256') != report.get('file_sha256')
                db.execute('''UPDATE round1_runs SET state=?, validation_json=?,
                    evidence_note=CASE WHEN ? THEN NULL ELSE evidence_note END,
                    evidence_at=CASE WHEN ? THEN NULL ELSE evidence_at END
                    WHERE run_id=?''',
                    (state, json.dumps(report, ensure_ascii=False), evidence_changed,
                     evidence_changed, run_id))
                db.commit()
            return self.status(run_id)

    def evidence(self, run_id, note):
        note = str(note or '').strip()
        if len(note) < 12 or len(note) > 1000:
            raise Round1Error('请填写至少 12 字的 WorkBuddy 会话或日志核验记录', 422)
        with self.lock, self.db() as db:
            row = self._run(db, run_id)
            if row['state'] != 'STRUCTURE_VALID':
                raise Round1Error('需先通过候选 MD 结构核验', 409)
            report = json.loads(row['validation_json'] or '{}')
            if not report.get('valid_structure') or not report.get('file_sha256'):
                raise Round1Error('候选 MD 缺少有效核验摘要', 409)
            poc.mark_skills_verified(self._safe_dir(row))
            db.execute('UPDATE round1_runs SET evidence_note=?, evidence_at=? WHERE run_id=?',
                       (note, timestamp(), run_id))
            db.commit()
            return self.status(run_id)

    def promote(self, run_id):
        with self.lock, self.db() as db:
            row = self._run(db, run_id)
            if row['state'] == 'OFFICIAL_READY':
                return self.status(run_id)
            if not row['evidence_note']:
                raise Round1Error('未登记双 Skill 人工核验记录', 409)
            run_dir = self._safe_dir(row)
            output = run_dir / '正式研究任务包.md'
            if output.is_symlink() or not output.is_file() or output.stat().st_size > 2_000_000:
                raise Round1Error('候选 MD 不存在或不符合受控文件要求', 422)
            report = poc.validate(run_dir)
            if not report['valid_structure']:
                raise Round1Error('候选 MD 结构核验失败：' + '; '.join(report['errors']), 422)
            markdown = output.read_text(encoding='utf-8-sig')
            digest = hashlib.sha256(markdown.encode('utf-8')).hexdigest()
            if digest != report['file_sha256']:
                raise Round1Error('核验后文件发生变化，请重新检查', 409)
            prior_report = json.loads(row['validation_json'] or '{}')
            if digest != prior_report.get('file_sha256'):
                raise Round1Error('人工 Skill 核验后候选文件已变化，请重新检查并登记证据', 409)
            revision, raw = db.execute('SELECT revision,value FROM app_state WHERE id=1').fetchone()
            state = json.loads(raw)
            _, cycle = self._cycle(state, row['project_id'], row['dimension_id'], row['cycle_id'])
            version = len(cycle.get('taskVersions', [])) + 1
            created_at = timestamp()
            task = {'id': run_id, 'version': version, 'createdAt': created_at,
                    'text': markdown, 'sha256': digest, 'skillEvidence': 'VERIFIED_BY_OPERATOR'}
            cycle.setdefault('taskVersions', []).append(task)
            cycle['stage'] = max(cycle.get('stage', 0), 1)
            db.execute('''INSERT INTO round1_packages(run_id,project_id,dimension_id,cycle_id,version,sha256,markdown,created_at)
                VALUES(?,?,?,?,?,?,?,?)''', (run_id, row['project_id'], row['dimension_id'],
                row['cycle_id'], version, digest, markdown, created_at))
            db.execute('UPDATE app_state SET revision=?,value=? WHERE id=1',
                       (revision + 1, json.dumps(state, ensure_ascii=False)))
            db.execute('''UPDATE round1_runs SET state='OFFICIAL_READY',package_hash=?,package_version=?,validation_json=? WHERE run_id=?''',
                       (digest, version, json.dumps(report, ensure_ascii=False), run_id))
            db.commit()
            run = poc.load_json(run_dir / 'run.json')
            run.update(state='OFFICIAL_READY', official_sha256=digest, official_at=created_at)
            poc.save_json(run_dir / 'run.json', run)
            return {'revision': revision + 1, 'state': state, **self.status(run_id)}

    def send(self, run_id):
        if not os.environ.get('WORKBUDDY_ACCESS_TOKEN'):
            raise Round1Error('未配置官方 WorkBuddy Open API 授权令牌', 409)
        with self.lock, self.db() as db:
            row = self._run(db, run_id)
            if row['state'] != 'PREPARED':
                raise Round1Error('当前状态不可重复投递', 409)
            db.execute("UPDATE round1_runs SET state='SENDING' WHERE run_id=?", (run_id,))
            db.commit()
            run_dir = self._safe_dir(row)
        try:
            result = poc.dispatch(run_dir, True)
        except Exception as exc:
            run = poc.load_json(run_dir / 'run.json')
            state = 'UNKNOWN' if run['state'] == 'SEND_UNCERTAIN' else 'PREPARED'
            with self.lock, self.db() as db:
                db.execute('UPDATE round1_runs SET state=? WHERE run_id=?', (state, run_id))
                db.commit()
            raise Round1Error(str(exc), 502) from exc
        with self.lock, self.db() as db:
            db.execute("UPDATE round1_runs SET state='SENT',message_id=? WHERE run_id=?",
                       (result['workbuddy_message_id'], run_id))
            db.commit()
        return self.status(run_id)

    def poll(self, run_id):
        with self.lock, self.db() as db:
            row = self._run(db, run_id)
            run_dir = self._safe_dir(row)
        if not row['message_id']:
            raise Round1Error('尚无官方 API messageId', 409)
        observation = poc.fetch_reply(run_dir)
        return {'observation': observation, **self.status(run_id)}
