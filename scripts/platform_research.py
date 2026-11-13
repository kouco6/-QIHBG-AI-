"""S1 research admission contract. No executor or research output is fabricated.

Only the admission boundary is enabled until professional Skills and an
authorized device exist. Existing platform identity and BG project ownership
remain authoritative. This module never writes BG state or creates AI tasks.
"""

import re
from urllib.parse import parse_qs


VERSION = 's1-research-v1'
PREFIX = '/platform/research'
REQUEST_FIELDS = {
    'sourceModule', 'projectId', 'dimensionId', 'cycleId', 'skillVersion',
    'schemaVersion', 'supplement', 'inputRefs', 'idempotencyKey',
    'executorId', 'selectionMode', 'executorMemberId',
}
DIMENSIONS = tuple(f'DIM-{i:02d}' for i in range(1, 13))
ID = re.compile(r'[A-Za-z0-9._-]{1,120}\Z')


class ResearchError(Exception):
    def __init__(self, status, code, message, **details):
        super().__init__(message)
        self.status, self.code, self.details = status, code, details

    def response(self):
        return {
            'contractVersion': VERSION, 'accepted': False,
            'error': {'code': self.code, 'message': str(self), 'details': self.details},
        }


def contract():
    """Executable/readable technical contract; planned operations are explicit."""
    request = {
        'type': 'object', 'additionalProperties': False,
        'required': sorted(REQUEST_FIELDS - {'supplement', 'inputRefs', 'executorId', 'selectionMode', 'executorMemberId'}),
        'properties': {
            'executorId': {'enum': ['workbuddy-local', 'codex-local', 'model-api', 'workbuddy-api']},
            'selectionMode': {'enum': ['manual', 'auto']},
            'executorMemberId': {'type': 'string'},
            'sourceModule': {'const': 'bg'},
            'projectId': {'type': 'string', 'pattern': '^[A-Za-z0-9._-]{1,120}$'},
            'dimensionId': {'enum': list(DIMENSIONS)},
            'cycleId': {'type': 'string', 'pattern': '^[A-Za-z0-9._-]{1,120}$'},
            'skillVersion': {'type': ['string', 'null'], 'maxLength': 128},
            'schemaVersion': {'const': 'v5'},
            'supplement': {'type': 'string', 'maxLength': 12000},
            'inputRefs': {'type': 'array', 'maxItems': 0},
            'idempotencyKey': {'type': 'string', 'pattern': '^[A-Za-z0-9._:-]{8,128}$'},
        },
    }
    paths = {
        PREFIX + '/contract': {'get': {
            'summary': 'Public technical contract; no account or business data',
            'security': [], 'responses': {'200': {'description': 'Current contract'}},
        }},
        PREFIX + '/capabilities': {'get': {
            'summary': 'Authenticated readiness; ready=false until actual execution is integrated',
            'responses': {'200': {'description': 'Readiness, never a model result'},
                          '401': {'description': 'Not authenticated'}, '403': {'description': 'Not authorized'}},
        }},
        PREFIX + '/tasks': {'post': {
            'summary': 'Existing TaskManager admission; local pull needs explicit isolated configuration',
            'x-implementation-status': 'local-pull-verification',
            'requestBody': {'required': True, 'content': {'application/json': {'schema': request}}},
            'responses': {str(code): {'description': text} for code, text in [
                (200, 'Idempotent existing task'), (202, 'Durably queued; NOT research success'),
                (400, 'Invalid JSON'), (401, 'Not authenticated'), (403, 'Not authorized'),
                (404, 'Project/cycle not owned or not found'), (409, 'Archived project'),
                (413, 'Request too large'), (415, 'JSON content type required'),
                (422, 'Invalid/unsupported request'), (503, 'Actual WorkBuddy setup/auth/online/protocol blocker; no taskId created'),
            ]},
        }, 'get': {
            'summary': 'Existing gateway query; requires owned projectId',
            'x-implementation-status': 'implemented',
            'parameters': [{'name': 'projectId', 'in': 'query', 'required': True,
                            'schema': {'type': 'string'}}],
            'responses': {'200': {'description': 'Owned research tasks'}, '404': {'description': 'Not owned/found'}},
        }},
    }
    for name, code in [('tasks/{taskId}', 'RESEARCH_QUERY_NOT_IMPLEMENTED'),
                       ('results/{taskId}', 'RESEARCH_RESULT_NOT_IMPLEMENTED')]:
        paths[PREFIX + '/' + name] = {'get': {
            'summary': 'Owned real state or verified result; no synthetic success',
            'x-implementation-status': 'implemented',
            'parameters': [
                {'name': 'taskId', 'in': 'path', 'required': True, 'schema': {'type': 'string'}},
                {'name': 'projectId', 'in': 'query', 'required': True, 'schema': {'type': 'string'}},
            ], 'responses': {'200': {'description': 'Task or complete verified pair'},
                             '404': {'description': 'Not owned/found'}, '409': {'description': 'Result not verified/ready'}},
        }}
    for suffix, verb, summary in [
        ('/workbuddy', 'get', 'WorkBuddy nonsecret connection requirements and readiness'),
        ('/workbuddy/authorization', 'post', 'Begin employee-bound OAuth; application setup must already be approved'),
        ('/workbuddy/callback', 'get', 'Single-use employee-bound OAuth callback; never returns credentials'),
        ('/workbuddy/online', 'post', 'Explicit online check using the newly authorized employee grant'),
        ('/workbuddy/refresh', 'post', 'Refresh only the dedicated new application grant'),
    ]:
        paths[PREFIX + suffix] = {verb: {'summary': summary,
            'responses': {'200': {'description': 'Connection operation; not research success'},
                          '401': {'description': 'Not authorized or grant expired'},
                          '403': {'description': 'Scope/owner/state rejected'},
                          '503': {'description': 'Application/grant/callback setup not ready'}}}}
    return {
        'openapi': '3.1.0', 'info': {'title': 'S1 DIM-03 research admission', 'version': VERSION},
        'servers': [{'url': '/'}],
        'security': [{'platformSession': []}],
        'components': {'securitySchemes': {'platformSession': {
            'type': 'apiKey', 'in': 'cookie', 'name': 'bg_platform_session',
        }}},
        'paths': paths,
        'x-current-status': 'WorkBuddy OAuth/localassistant adapter prepared; live authorization and execution delivery unverified',
        'x-boundaries': {
            'researchExecutor': 'Verified executor adapters share one Skill package and result contract; no unapproved fallback',
            'skillInstallation': 'One full hash-bound Skill package; native discovery is not execution evidence; no clipping',
            'workbuddyTransport': 'Local authenticated pull is current priority; optional OAuth adapter retained but not enabled',
            'identity': 'Existing server-side platform session; require bg and ai grants',
            'ownership': 'Project/cycle looked up only in the authenticated account BG service',
            'projectBackground': 'Will be read from owned project, never trust client ownership/background claims',
            'idempotency': 'Existing TaskManager: owner/project/dimension/cycle/key and input digest',
            'deviceProtocol': 'Scoped member claim/lease/heartbeat; native scheduled execution and evidence verification still unverified',
            'successContract': 'Same task/version MD+JSON archive; success blocked without verified native execution evidence',
            'legacyRound1': 'Unchanged manual DIM-01 path; this API never triggers it or creates a parallel executor',
            'dataProtection': 'No W/D/P writes; rejected admission creates no accepted task',
        },
    }


def authorize(account):
    if not account:
        raise ResearchError(401, 'AUTHENTICATION_REQUIRED', '请先通过统一入口登录。')
    if not {'bg', 'ai'}.issubset(set(account.get('modules', []))):
        raise ResearchError(403, 'RESEARCH_NOT_AUTHORIZED', '当前账号没有企划研究所需的模块授权。')


def identifier(value, field):
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise ResearchError(422, 'INVALID_REQUEST', '标识字段格式无效。', field=field)


def validate_request(value):
    if not isinstance(value, dict):
        raise ResearchError(422, 'INVALID_REQUEST', '研究请求必须为 JSON 对象。')
    missing = REQUEST_FIELDS - {'supplement', 'inputRefs', 'executorId', 'selectionMode', 'executorMemberId'} - set(value)
    unknown = set(value) - REQUEST_FIELDS
    if missing or unknown:
        # Do not reflect user-supplied values or unknown property names.
        raise ResearchError(422, 'INVALID_REQUEST', '研究请求字段不完整或包含未允许字段。',
                            missingFields=sorted(missing), hasUnknownFields=bool(unknown))
    for name in ('projectId', 'cycleId'):
        identifier(value[name], name)
    if not isinstance(value.get('executorId', 'workbuddy-local'), str) or value.get('executorId', 'workbuddy-local') not in {'workbuddy-local', 'codex-local', 'model-api', 'workbuddy-api'}:
        raise ResearchError(422, 'INVALID_EXECUTOR_SELECTION', '执行器名称无效。')
    if not isinstance(value.get('selectionMode', 'manual'), str) or value.get('selectionMode', 'manual') not in {'manual', 'auto'}:
        raise ResearchError(422, 'INVALID_EXECUTOR_SELECTION', '执行器选择模式无效。')
    if 'executorMemberId' in value:
        identifier(value['executorMemberId'], 'executorMemberId')
    if value['sourceModule'] != 'bg':
        raise ResearchError(422, 'INVALID_SOURCE_MODULE', '本接口只接收产品企划中心的研究请求。')
    if value['dimensionId'] not in DIMENSIONS:
        raise ResearchError(422, 'DIMENSION_NOT_ENABLED', '研究维度不存在。')
    if value['schemaVersion'] != 'v5':
        raise ResearchError(422, 'SCHEMA_VERSION_UNSUPPORTED', 'DIM-03 沿用既有 v5 结构。')
    skill = value['skillVersion']
    if skill is not None and (not isinstance(skill, str) or not 1 <= len(skill) <= 128):
        raise ResearchError(422, 'INVALID_SKILL_VERSION', 'Skill 版本格式无效。')
    supplement = value.get('supplement', '')
    if not isinstance(supplement, str) or len(supplement) > 12000:
        raise ResearchError(422, 'INVALID_SUPPLEMENT', '补充研究输入过长或类型无效。')
    if value.get('inputRefs', []) != []:
        raise ResearchError(422, 'INPUT_REFERENCES_NOT_ENABLED', '文件引用授权尚未接通，不能接受任意路径或文件引用。')
    key = value['idempotencyKey']
    if not isinstance(key, str) or not re.fullmatch(r'[A-Za-z0-9._:-]{8,128}', key):
        raise ResearchError(422, 'INVALID_IDEMPOTENCY_KEY', '幂等键格式无效。')


def owned_project(state, project_id, dimension_id=None, cycle_id=None):
    identifier(project_id, 'projectId')
    project = next((p for p in state.get('projects', []) if p.get('id') == project_id), None)
    if project is None:
        raise ResearchError(404, 'PROJECT_NOT_FOUND', '当前账号下未找到该企划项目。')
    if project.get('status') != 'active':
        raise ResearchError(409, 'PROJECT_NOT_ACTIVE', '归档或不可用项目不能发起研究。')
    if cycle_id is not None:
        cycles = state.get('cycles', {}).get(project_id + '|' + dimension_id, [])
        if not any(c.get('id') == cycle_id and c.get('projectId') == project_id
                   and c.get('dimensionId') == dimension_id for c in cycles):
            raise ResearchError(404, 'CYCLE_NOT_FOUND', '当前项目和维度下未找到该研究周期。')
    return project


def handle(method, path, query, account, read_owned_state, body=None, gateway=None):
    """Research admission stays gated; OAuth actions are explicit and employee-bound."""
    if path == PREFIX + '/contract' and method in {'GET', 'HEAD'}:
        return 200, contract()
    authorize(account)
    if path.startswith(PREFIX + '/workbuddy'):
        action = path[len(PREFIX + '/workbuddy'):]
        if gateway is None:
            raise ResearchError(503, 'WORKBUDDY_ADAPTER_NOT_CONNECTED', 'WorkBuddy 接入服务暂不可用。')
        if not action and method in {'GET', 'HEAD'}:
            return gateway.workbuddy()
        if action == '/callback' and method == 'GET':
            params = parse_qs(query, keep_blank_values=True)
            if set(params) != {'code', 'state'} or any(len(v) != 1 or not v[0] or len(v[0]) > 4096 for v in params.values()):
                raise ResearchError(422, 'INVALID_REQUEST', 'OAuth 回调参数无效。')
            return gateway.workbuddy('callback', {key: value[0] for key, value in params.items()})
        if action in {'/authorization', '/online', '/refresh'} and method == 'POST':
            if body != {}:
                raise ResearchError(422, 'INVALID_REQUEST', '本操作仅接受空 JSON 对象，不接收浏览器凭据。')
            return gateway.workbuddy(action[1:], {})
        raise ResearchError(405, 'METHOD_NOT_ALLOWED', 'WorkBuddy 接入操作方法无效。')
    if path == PREFIX + '/capabilities' and method in {'GET', 'HEAD'}:
        if gateway is None:
            raise ResearchError(503, 'WORKBUDDY_ADAPTER_NOT_CONNECTED', 'WorkBuddy 接入服务暂不可用。')
        return 200, gateway.capabilities()
    if path == PREFIX + '/tasks' and method == 'POST':
        validate_request(body)
        project = owned_project(read_owned_state(), body['projectId'], body['dimensionId'], body['cycleId'])
        if gateway is not None:
            return gateway.create(body, project)
        raise ResearchError(503, 'WORKBUDDY_ADAPTER_NOT_CONNECTED',
                            'WorkBuddy 接入服务暂不可用；未创建任务。', taskCreated=False)
    query_routes = {PREFIX + '/tasks': 'RESEARCH_QUERY_NOT_IMPLEMENTED'}
    for segment, code in [('tasks', 'RESEARCH_QUERY_NOT_IMPLEMENTED'),
                           ('results', 'RESEARCH_RESULT_NOT_IMPLEMENTED')]:
        if re.fullmatch(re.escape(PREFIX) + '/' + segment + r'/[A-Za-z0-9._-]{1,120}', path):
            query_routes[path] = code
    if path in query_routes and method in {'GET', 'HEAD'}:
        params = parse_qs(query, keep_blank_values=True)
        project_ids = params.get('projectId', [])
        if len(project_ids) != 1:
            raise ResearchError(422, 'INVALID_REQUEST', '查询必须指定唯一 projectId。', field='projectId')
        owned_project(read_owned_state(), project_ids[0])
        if gateway is not None:
            tail = path[len(PREFIX) + 1:].split('/')
            return gateway.query(tail[0], project_ids[0], tail[1] if len(tail) > 1 else None)
        raise ResearchError(501, query_routes[path], '真实任务查询或成果交付尚未接通，不返回假状态或假成果。')
    known = path in {PREFIX + '/contract', PREFIX + '/capabilities', PREFIX + '/tasks'} or path in query_routes
    raise ResearchError(405 if known else 404, 'METHOD_NOT_ALLOWED' if known else 'ENDPOINT_NOT_FOUND',
                        '操作方法无效。' if known else '研究接口不存在。')
