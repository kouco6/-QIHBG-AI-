"""Server-authorized result -> W preview/confirm. No client-provided results."""
import base64
import hashlib
import hmac
import http.client
import json
import time

from platform_research import ResearchError, authorize, identifier, owned_project, DIMENSIONS


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


class ResearchSync:
    def __init__(self, modules, account, gateway):
        authorize(account)
        self.modules, self.account, self.gateway = modules, account, gateway

    def bg(self, method, path, body=None):
        port, _ = self.modules.get('bg', self.account['id'])
        conn = http.client.HTTPConnection('127.0.0.1', port, timeout=30)
        try:
            headers = {'X-Integration-Key': self.modules.key, 'X-Research-Sync': self.modules.key,
                       'Content-Type': 'application/json'}
            if method == 'POST':
                conn.request('GET', '/api/session', headers=headers)
                response = conn.getresponse()
                session = json.loads(response.read())
                if response.status != 200:
                    raise ValueError('session unavailable')
                headers['X-BG-Token'] = session['csrfToken']
            conn.request(method, path, canonical(body).encode() if body is not None else None, headers)
            response = conn.getresponse()
            data = response.read(50 * 1024 * 1024 + 1)
            if len(data) > 50 * 1024 * 1024:
                raise ValueError('oversize')
            value = json.loads(data)
            if response.status >= 400:
                raise ResearchError(response.status, value.get('code', 'RESEARCH_IMPORT_FAILED'),
                                    value.get('error', '工作区操作未确认成功。'))
            return value
        except ResearchError:
            raise
        except (OSError, ValueError, KeyError, http.client.HTTPException):
            raise ResearchError(503, 'RESEARCH_IMPORT_UNCONFIRMED', '工作区响应未确认；请查询任务版本同步记录，勿覆盖重试。') from None
        finally:
            conn.close()

    def context(self, value):
        if not isinstance(value, dict):
            raise ResearchError(422, 'INVALID_REQUEST', '同步请求格式无效。')
        for field in ('projectId', 'dimensionId', 'taskId'):
            identifier(value.get(field), field)
        if value['dimensionId'] not in DIMENSIONS or type(value.get('resultVersion')) is not int or value['resultVersion'] < 1:
            raise ResearchError(422, 'INVALID_REQUEST', '维度或成果版本无效。')
        state = self.bg('GET', '/api/state')
        owned_project(state['state'], value['projectId'])
        result = self.gateway.query('results', value['projectId'], value['taskId'])[1]
        if any(result.get(k) != value[k] for k in ('projectId', 'dimensionId', 'taskId', 'resultVersion')):
            raise ResearchError(409, 'RESEARCH_DELIVERY_BINDING_MISMATCH', '成果与所选任务、维度或版本不符。')
        if result.get('nativeInvocationVerified') is not True or result.get('resultAvailable') is not True:
            raise ResearchError(409, 'RESEARCH_RESULT_NOT_VERIFIED', '原生执行证据尚未验证，不能同步W。')
        return state, result

    def sign(self, claim):
        data = base64.urlsafe_b64encode(canonical(claim).encode()).decode().rstrip('=')
        mac = hmac.new(self.modules.key.encode(), data.encode(), hashlib.sha256).hexdigest()
        return data + '.' + mac

    def preview(self, value):
        if set(value) != {'projectId', 'dimensionId', 'taskId', 'resultVersion'}:
            raise ResearchError(422, 'INVALID_REQUEST', '预览请求字段无效。')
        state, result = self.context(value)
        old = state['state'].get('showcases', {}).get(value['projectId'], {}).get(value['dimensionId'])
        claim = {**value, 'owner': self.account['id'], 'revision': state['revision'],
                 'workHash': digest(old), 'sourceHash': digest(result['integrity']), 'expires': int(time.time()) + 600}
        return {**value, 'syncToken': self.sign(claim), 'expectedRevision': state['revision'],
                'hasWorkingChanges': bool(old and old.get('autoDirty')), 'backupRequired': old is not None,
                'expiresAt': claim['expires'], 'workingOnly': True}

    def confirm(self, value):
        fields = {'projectId', 'dimensionId', 'taskId', 'resultVersion', 'syncToken',
                  'expectedRevision', 'editingState', 'overwriteWorking'}
        if not isinstance(value, dict) or set(value) != fields or value.get('editingState') != 'saved' or type(value.get('overwriteWorking')) is not bool:
            raise ResearchError(422, 'EDITING_STATE_REQUIRED', '请先保存当前编辑并预览，在用户确认后提交同步。')
        try:
            data, mac = value['syncToken'].split('.')
            if len(data) > 4096 or not hmac.compare_digest(hmac.new(self.modules.key.encode(), data.encode(), hashlib.sha256).hexdigest(), mac):
                raise ValueError('invalid')
            claim = json.loads(base64.urlsafe_b64decode(data + '=' * (-len(data) % 4)))
            if claim['owner'] != self.account['id'] or claim['expires'] < time.time() or any(claim[k] != value[k] for k in ('projectId', 'dimensionId', 'taskId', 'resultVersion')):
                raise ValueError('invalid')
            if type(value['expectedRevision']) is not int or claim['revision'] != value['expectedRevision']:
                raise ValueError('revision')
        except (ValueError, TypeError, KeyError, AttributeError):
            raise ResearchError(409, 'RESEARCH_CONFIRMATION_EXPIRED', '确认已失效或不属于当前账号，请重新预览。') from None
        state, result = self.context({k: value[k] for k in ('projectId', 'dimensionId', 'taskId', 'resultVersion')})
        if digest(result['integrity']) != claim['sourceHash']:
            raise ResearchError(409, 'RESEARCH_RESULT_INTEGRITY_FAILED', '预览后成果关联发生变化。')
        return self.bg('POST', '/api/research/internal/import', {
            **{k: value[k] for k in ('projectId', 'dimensionId', 'taskId', 'resultVersion', 'expectedRevision', 'overwriteWorking')},
            'expectedWorkHash': claim['workHash'], 'result': result})
