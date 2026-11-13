"""Server-only bridge to the existing gateway /api/tasks and its TaskManager."""
import http.client
import json
from urllib.parse import urlencode

from platform_research import ResearchError


class ResearchGateway:
    def __init__(self, modules, account):
        self.modules, self.account = modules, account

    def call(self, method, path, body=None, key=None):
        try:
            port, token = self.modules.get('ai', self.account['id'])
            conn = http.client.HTTPConnection('127.0.0.1', port, timeout=30)
            headers = {'Authorization': 'Bearer ' + token,
                       'X-Research-Integration': self.modules.key,
                       'X-Research-Account': self.account['id'], 'Content-Type': 'application/json'}
            if key: headers['X-Idempotency-Key'] = key
            try:
                raw = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
                conn.request(method, path, body=raw, headers=headers)
                response = conn.getresponse(); data = response.read(20 * 1024 * 1024 + 1)
                if len(data) > 20 * 1024 * 1024: raise ValueError('oversize')
                value = json.loads(data)
                if response.status >= 400:
                    code = value.get('code', 'GATEWAY_REQUEST_REJECTED')
                    raise ResearchError(response.status, code, '网关拒绝受理或交付；请按错误码核对执行条件。',
                                        taskCreated=bool(value.get('taskId')))
                return response.status, value
            finally: conn.close()
        except ResearchError: raise
        except (OSError, ValueError, RuntimeError, TypeError, http.client.HTTPException):
            raise ResearchError(503, 'GATEWAY_UNAVAILABLE', '现有 AI 调度中心暂不可用，未切换其他执行链。') from None

    def runtime(self):
        return self.call('GET', '/api/research/runtime')[1]

    def capabilities(self):
        runtime = self.runtime()
        native = runtime.get('codexNative') or {}
        if native.get('enabled'):
            dimensions = native['dimensions']
            return {'contractVersion': 's1-research-v1', 'implementation': 'existing-codex-app-server',
                    'ready': bool(native.get('taskCreationEnabled')), 'taskCreationEnabled': bool(native.get('taskCreationEnabled')),
                    'queryEnabled': True, 'resultDeliveryEnabled': True, 'researchSuccessVerified': False,
                    'researchExecutor': 'codex-local', 'genericRunnerFallbackAllowed': False,
                    'blockedReasons': [native['error']] if native.get('error') else [],
                    'codexNative': native, 'dimensions': dimensions}
        local = runtime.get('localPull') or {}
        dimensions = [dict(d) for d in runtime['dimensions']]
        if local.get('skill'):
            skill = local['skill']
            dimensions[2].update(skillName=skill['name'], skillVersion=skill['version'],
                                 skillStatus='integrity-checked-native-unverified', enabled=False)
        reasons = [] if local.get('enabled') else ['LOCAL_RESEARCH_NOT_CONFIGURED']
        if local.get('error'): reasons.append(local['error'])
        if local.get('enabled') and not local.get('capabilityVerified'): reasons.append('NATIVE_EXECUTION_VERIFICATION_REQUIRED')
        return {'contractVersion': 's1-research-v1', 'implementation': 'existing-gateway-local-pull',
                'ready': bool(local.get('taskCreationEnabled')), 'taskCreationEnabled': bool(local.get('taskCreationEnabled')),
                'queryEnabled': True, 'resultDeliveryEnabled': bool(local.get('enabled')),
                'researchSuccessVerified': False, 'researchExecutor': 'workbuddy-local',
                'oauthRequired': False, 'genericRunnerFallbackAllowed': False, 'blockedReasons': reasons,
                'localPull': local, 'executors': local.get('executors', []), 'dimensions': dimensions}

    def create(self, body, project):
        # Reuse the existing gateway admission boundary. Its dedicated adapter
        # rejects until authorization/online/native execution and delivery are proven.
        context = {key: project.get(key) for key in ('id', 'name', 'type', 'background')}
        status, value = self.call('POST', '/api/tasks', {
            'agent': 'workbuddy', 'taskType': 'planning_research',
            'research': {key: body[key] for key in ('projectId', 'dimensionId', 'cycleId', 'skillVersion', 'schemaVersion')},
            'projectContext': context, 'supplement': body.get('supplement', ''),
            **{key: body[key] for key in ('executorId', 'selectionMode', 'executorMemberId') if key in body},
        }, body['idempotencyKey'])
        return status, {'contractVersion': 's1-research-v1', **value}

    def workbuddy(self, action='', body=None):
        path = '/api/research/workbuddy' + ('/' + action if action else '')
        return self.call('POST' if action else 'GET', path, body if action else None)

    def query(self, kind, project_id, task_id=None, filters=None):
        params = {'projectId': project_id}
        params.update({k: v for k, v in (filters or {}).items() if k in {'dimensionId', 'cycleId'}})
        path = '/api/research/' + kind + ('/' + task_id if task_id else '') + '?' + urlencode(params)
        status, value = self.call('GET', path)
        return status, {'contractVersion': 's1-research-v1', **value}
