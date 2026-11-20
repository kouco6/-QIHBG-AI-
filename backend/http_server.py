import http.client, json, mimetypes, re, secrets, sqlite3, threading, time
from pathlib import Path
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, unquote, urlsplit
from identity import REMEMBER_AGE
from exhibitions import Exhibitions, ExhibitionError, PREFIX as EXHIBITION_PREFIX
from dashboard_snapshot import snapshot_dashboard, LedgerError
from planning_templates import Templates, TemplateError, archive
from planning_templates_v2 import PREFIX as V2_TEMPLATE_PREFIX, migrate_package
ROOT = Path(__file__).resolve().parents[1]
TEMPLATE_PREFIX = V2_TEMPLATE_PREFIX
COOKIE = "bg_platform_session"
HOP_HEADERS = {"connection","keep-alive","proxy-authenticate","proxy-authorization","te","trailer","transfer-encoding","upgrade"}
REQUEST_HEADERS = {"accept","accept-language","content-type","last-event-id","range","if-match","if-none-match","if-modified-since","x-request-id","x-idempotency-key","user-agent"}

class Server(ThreadingHTTPServer):
    daemon_threads = True
    def __init__(self, settings, identity, modules):
        self.settings, self.identity, self.modules = settings, identity, modules
        self.template_lock = threading.RLock()
        self.template_tickets = {}
        super().__init__(("127.0.0.1", settings.port), Handler)

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, template, *args):
            # No cookie, token, query string or user content in the entry logs.
            return

    def _headers(self, status, mime, length=None, headers=()):
            self.send_response(status)
            if mime:
                self.send_header("Content-Type", mime)
            if length is not None:
                self.send_header("Content-Length", str(length))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "same-origin")
            self.send_header("X-Frame-Options", "SAMEORIGIN")
            self.send_header("Connection", "close")
            for name, value in headers:
                self.send_header(name, value)
            self.end_headers()
            self.close_connection = True

    def _json(self, status, value, headers=()):
            payload = json.dumps(value, ensure_ascii=False).encode()
            self._headers(status, "application/json; charset=utf-8", len(payload), headers)
            if self.command != "HEAD":
                self.wfile.write(payload)

    def _file(self, path):
            mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            if path.suffix in {".html", ".js", ".css"}:
                mime = {".html": "text/html", ".js": "text/javascript", ".css": "text/css"}[path.suffix] + "; charset=utf-8"
            with path.open("rb") as stream:
                self._headers(200, mime, path.stat().st_size)
                if self.command != "HEAD":
                    while chunk := stream.read(65536):
                        self.wfile.write(chunk)

    def _token(self):
            cookie = SimpleCookie()
            try:
                cookie.load(self.headers.get("Cookie", ""))
            except CookieError:
                return ""
            return cookie[COOKIE].value if COOKIE in cookie else ""

    def _length(self, maximum):
            if self.headers.get("Transfer-Encoding"):
                raise ValueError("不支持该请求传输格式。")
            lengths = self.headers.get_all("Content-Length", [])
            if len(lengths) > 1 or (lengths and not re.fullmatch(r"[0-9]{1,10}", lengths[0])):
                raise ValueError("请求长度无效。")
            length = int(lengths[0]) if lengths else 0
            if length > maximum:
                raise ValueError("请求内容过大。")
            return length

    def _cookie(self, value, max_age=None):
            cookie = f"{COOKIE}={value}; Path=/; HttpOnly; SameSite=Strict"
            if max_age is not None:
                cookie += f"; Max-Age={max_age}"
            return (("Set-Cookie", cookie),)

    def _proxy(self, module, parsed, upstream_path, account, cookie, document):
            account_key = account["id"]
            try:
                port, ai_token = self.server.modules.get(module, account_key)
            except Exception:
                return self._error(503, "业务服务未启动。请重试或查看启动日志。", document)
            length = self._length(200 * 1024 * 1024)
            peer = f"127.0.0.1:{port}"
            headers = {key: val for key, val in self.headers.items() if key.lower() in REQUEST_HEADERS}
            headers.update({"Host": peer, "Connection": "close"})
            if self.headers.get("Content-Length"):
                headers["Content-Length"] = str(length)
            if self.headers.get("Origin"):
                headers["Origin"] = f"http://{peer}"
            headers["Authorization"] = f"Bearer {ai_token}"
            headers["X-Integration-Account"] = quote(account["login"], safe="")
            headers["X-Integration-Name"] = quote(account["name"], safe="")
            headers["X-Integration-Admin"] = "1" if account["role"] == "admin" else "0"
            headers["X-Integration-Runner-Base"] = f"http://{self.headers['Host']}/platform/runner/{account['id']}"
            target = upstream_path + (f"?{parsed.query}" if parsed.query else "")
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=45)
            sent = False
            try:
                conn.putrequest(self.command, target, skip_host=True, skip_accept_encoding=True)
                for key, val in headers.items():
                    conn.putheader(key, val)
                conn.endheaders()
                while length:
                    chunk = self.rfile.read(min(length, 65536))
                    if not chunk:
                        return self._error(400, "请求中途断开。")
                    conn.send(chunk)
                    length -= len(chunk)
                upstream = conn.getresponse()
                result_headers = []
                for key, val in upstream.getheaders():
                    lower = key.lower()
                    if lower in HOP_HEADERS or lower in {
                        "server", "date", "set-cookie", "cache-control", "content-length",
                        "content-type", "x-frame-options", "x-content-type-options", "referrer-policy",
                    } or lower.startswith("access-control-"):
                        continue
                    if lower == "location" and val.startswith("/") and not val.startswith("//"):
                        val = f"/{module}{val}"
                    result_headers.append((key, val))
                mime = upstream.getheader("Content-Type", "application/octet-stream")
                if module == "ai" and upstream_path.startswith("/api/") and mime.startswith("text/html"):
                    result_headers.append(("Content-Security-Policy", "sandbox"))
                self._headers(upstream.status, mime, upstream.getheader("Content-Length"), result_headers)
                sent = True
                if self.command == "HEAD":
                    return
                streaming = mime.startswith("text/event-stream")
                while chunk := upstream.read1(65536):
                    if streaming:
                        current = self.server.identity.current(cookie)
                        if not current or current['must_change_password'] or current["id"] != account["id"] or module not in current["modules"]:
                            break
                    self.wfile.write(chunk)
                    if streaming:
                        self.wfile.flush()
            except (OSError, http.client.HTTPException):
                if not sent:
                    self._error(502, "业务服务连接已中断。请重试或查看启动日志。", document)
            finally:
                conn.close()

    def _runner_member(self, parsed):
            """Route a private instance's runner protocol without substituting a master token."""
            match = re.fullmatch(r'/platform/runner/([a-f0-9]{32})/api/runner/(bootstrap|claim|heartbeat|finish)', parsed.path)
            if not match or parsed.query or self.command != 'POST':
                return self._error(404, '执行器接口不存在。')
            account_id, action = match.groups()
            authorization = self.headers.get('Authorization', '')
            if action != 'bootstrap' and not re.fullmatch(r'Bearer cb_[A-Za-z0-9_-]{16,128}', authorization):
                return self._error(401, '需要有效执行器身份。')
            with self.server.identity.db() as db:
                account = db.execute('SELECT id FROM account WHERE id=? AND active=1 AND must_change_password=0', (account_id,)).fetchone()
                granted = db.execute("SELECT 1 FROM grant_module WHERE account=? AND module='ai'", (account_id,)).fetchone()
            if not account or not granted:
                return self._error(403, '当前账号无调度权限。')
            try:
                length = self._length(2 * 1024 * 1024)
                body = self.rfile.read(length)
                if len(body) != length: return self._error(400, '请求中途断开。')
                port, _ = self.server.modules.get('ai', account_id)
                conn = http.client.HTTPConnection('127.0.0.1', port, timeout=45)
                try:
                    conn.request('POST', '/api/runner/' + action, body=body,
                                 headers={'Authorization': authorization, 'Content-Type': 'application/json'})
                    response = conn.getresponse()
                    raw = response.read(2 * 1024 * 1024 + 1)
                    if len(raw) > 2 * 1024 * 1024 or 300 <= response.status < 400:
                        return self._error(502, '执行器响应无效。')
                    return self._json(response.status, json.loads(raw))
                finally: conn.close()
            except (OSError, RuntimeError, http.client.HTTPException, ValueError):
                return self._error(503, '执行器服务暂不可用。')

    def _exhibitions(self, parsed, account, cookie):
        if not account:
            return self._error(401, '登录已失效。')
        if account['must_change_password'] or 'bg' not in account['modules']:
            return self._error(403, '当前账号没有企划模块访问权限。')
        try:
            with self.server.template_lock:
                if not hasattr(self.server, 'exhibitions'):
                    self.server.exhibitions = Exhibitions(self.server.settings.data)
                store = self.server.exhibitions
            suffix = parsed.path[len(EXHIBITION_PREFIX):]
            read = self.command in {'GET', 'HEAD'}
            if suffix == '' and read:
                return self._json(200, store.listing(account))
            if suffix == '/maintainers':
                if account['role'] != 'admin':
                    return self._error(403, '只有管理员可以指定维护人员。')
                people = [p for p in self.server.identity.list_accounts(cookie)
                          if p['active'] and 'bg' in p['modules'] and p['role'] != 'admin']
                if read:
                    return self._json(200, {
                        'items': [{'id': p['id'], 'name': p['name'], 'login': p['login']} for p in people],
                        'selected': store.maintainers()})
            if read:
                return self._error(404, '展会接口不存在。')
            if self.command != 'POST':
                return self._error(405, '展会维护仅支持 POST。')
            current = self.server.identity.current(cookie)
            if (not current or current['must_change_password'] or 'bg' not in current['modules']
                    or not store.can_manage(current)):
                return self._error(403, '当前账号没有展会维护权限。')
            if suffix == '/import':
                from urllib.parse import parse_qs
                name = parse_qs(parsed.query).get('filename', ['展会调研.xlsx'])[0]
                if not name.lower().endswith('.xlsx'):
                    raise ExhibitionError('请上传 .xlsx 文件。')
                payload = self.rfile.read(self._length(10 * 1024 * 1024))
                return self._json(200, store.import_xlsx(payload, name, current))
            if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
                raise ExhibitionError('请使用 JSON 提交。', 415)
            raw = json.loads(self.rfile.read(self._length(256 * 1024)))
            if not isinstance(raw, dict):
                raise ExhibitionError('请求内容须为对象。')
            if suffix == '/maintainers':
                if current['role'] != 'admin':
                    return self._error(403, '只有管理员可以指定维护人员。')
                ids = raw.get('ids')
                if not isinstance(ids, list) or any(not isinstance(i, str) for i in ids):
                    raise ExhibitionError('维护人员无效。')
                if not set(ids) <= {p['id'] for p in people}:
                    raise ExhibitionError('请选择已启用且有企划权限的普通用户。')
                return self._json(200, store.set_maintainers(ids))
            if suffix == '/topics':
                return self._json(200, store.topic(raw, current))
            if suffix == '/records':
                return self._json(201, store.save(raw, current))
            matched = re.fullmatch(r'/records/([a-f0-9]{32})(/archive)?', suffix)
            if matched:
                if matched[2]:
                    return self._json(200, store.archive(matched[1], raw.get('revision'), raw.get('archived'), current))
                return self._json(200, store.save(raw, current, matched[1], raw.get('revision')))
            return self._error(404, '展会操作不存在。')
        except ExhibitionError as error:
            return self._error(error.status, str(error))
        except (ValueError, TypeError):
            return self._error(400, '展会请求格式无效或内容过大。')
        except (OSError, sqlite3.Error):
            return self._error(503, '展会存储暂不可用，请重试。')

    def _templates(self, parsed, account, cookie):
            server = self.server
            v2 = parsed.path == V2_TEMPLATE_PREFIX or parsed.path.startswith(V2_TEMPLATE_PREFIX + '/')
            api_prefix = V2_TEMPLATE_PREFIX if v2 else TEMPLATE_PREFIX
            parts = parsed.path[len(api_prefix):].strip('/').split('/')
            preview = parts[0] == 'preview'
            if preview:
                if len(parts) < 4:
                    return self._error(404, '预览资源不存在。')
                with server.template_lock:
                    session = server.template_tickets.get(parts[1], '')
                account = server.identity.current(session)
            if not account:
                return self._error(401, '登录已失效，请重新打开模板管理。')
            if account['must_change_password'] or 'bg' not in account['modules']:
                return self._error(403, '当前账号没有企划模块的访问权限。')
            try:
                with server.template_lock:
                    if not hasattr(server, 'templates_v2'):
                        baseline = lambda: archive({p.relative_to(ROOT / 'baseline').as_posix(): p.read_bytes() for p in (ROOT / 'baseline').rglob('*') if p.is_file()})
                        server.templates_v2 = Templates(server.settings.data / 'planning-templates', ROOT / 'backend/template-contract', baseline)
                    registry = server.templates_v2
                if preview or parts[0] == 'versions' and len(parts) >= 3:
                    if self.command not in {'GET', 'HEAD'}:
                        return self._error(405, '模板资源仅支持读取。')
                    version_id = parts[2] if preview else parts[1]
                    name = '/'.join(parts[3:] if preview else parts[2:])
                    if preview and name == 'package.zip':
                        return self._error(403, '预览链接不能下载模板包。')
                    path = registry.asset(version_id, name)
                    prefix = api_prefix + ('/preview/' + parts[1] if preview else '/versions') + '/' + version_id
                    payload = path.read_bytes()
                    headers = [('Access-Control-Allow-Origin', '*')] if preview else []
                    mime = mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
                    if path.suffix in {'.html','.js','.css'}:
                        source = payload.decode('utf-8')
                        source = source.replace('/bg/dimension-assets/', prefix + '/assets/').replace('/dimension-assets/', prefix + '/assets/')
                        payload = source.encode('utf-8')
                        mime = {'.html':'text/html','.js':'text/javascript','.css':'text/css'}[path.suffix] + '; charset=utf-8'
                    if preview and path.suffix == '.html':
                        # Sandboxed documents cannot bubble keys to the management page.
                        # Keep Escape working without granting same-origin access.
                        escape_bridge = '''<script>
    window.addEventListener('keydown', function(event) {
      if (event.key !== 'Escape' || event.target.closest('input,textarea,select,[contenteditable="true"]') ||
          document.querySelector('dialog[open],.modal,.edit-mask:not([hidden])')) return;
      setTimeout(function() {
        if (!event.defaultPrevented) window.parent.postMessage({type:'bg-template-preview-escape'}, location.origin);
      }, 0);
    });
    </script>'''
                        source = payload.decode('utf-8')
                        closing_head = re.search(r'</head\s*>', source, re.IGNORECASE)
                        if closing_head:
                            source = source[:closing_head.start()] + escape_bridge + source[closing_head.start():]
                        else:
                            source += escape_bridge
                        payload = source.encode('utf-8')
                        prefix = f'http://{self.headers.get("Host")}' + prefix
                        headers.append(('Content-Security-Policy', "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' " + prefix + "/assets/; style-src 'unsafe-inline' " + prefix + "/assets/; img-src data: blob: " + prefix + "/assets/; font-src " + prefix + "/assets/; connect-src " + prefix + "/assets/; form-action 'none'; base-uri 'none'"))
                    if name == 'package.zip':
                        headers.append(('Content-Disposition', 'attachment; filename="planning-template-' + version_id[:12] + '.zip"'))
                    self._headers(200, mime, len(payload), headers)
                    if self.command != 'HEAD':
                        self.wfile.write(payload)
                    return
                if parts == ['samples'] and self.command in {'GET','HEAD'}:
                    return self._json(200, {f'DIM-{i:02d}':json.loads((ROOT / 'baseline/samples' / f'dim{i:02d}.json').read_text(encoding='utf-8')) for i in range(1,13)})
                if parts == [''] and self.command in {'GET','HEAD'}:
                    with server.template_lock:
                        # Preview capabilities are session-bound and revalidated for every resource.
                        for ticket, session in list(server.template_tickets.items()):
                            if not server.identity.current(session):
                                del server.template_tickets[ticket]
                        ticket = next((t for t, value in server.template_tickets.items() if value == cookie), None)
                        if not ticket:
                            if len(server.template_tickets) >= 1024:
                                raise TemplateError('预览会话过多，请稍后重试。',503)
                            ticket = secrets.token_urlsafe(32)
                            server.template_tickets[ticket] = cookie
                    return self._json(200, {**registry.listing(), 'canManage':account['role']=='admin', 'previewTicket':ticket})
                if account['role'] != 'admin':
                    return self._error(403, '模板导入及应用仅向管理员开放。')
                if parts == ['import'] and self.command == 'POST':
                    if self.headers.get('Content-Type','').split(';')[0] not in {'application/zip','application/octet-stream'}:
                        raise TemplateError('请上传ZIP模板包。',415)
                    payload = self.rfile.read(self._length(32 * 1024 * 1024))
                    if v2:
                        registry._validate(payload)
                        payload = migrate_package(payload, registry.source, ROOT)
                    current = server.identity.current(cookie)
                    if not current or current['role'] != 'admin':
                        return self._error(403, '管理员权限已失效。')
                    return self._json(201, registry.import_package(payload, account['name']))
                if parts == ['apply'] and self.command == 'POST':
                    body = self._body_json()
                    current = server.identity.current(cookie)
                    if not current or current['role'] != 'admin':
                        return self._error(403, '管理员权限已失效。')
                    return self._json(200, registry.apply(body.get('id'), body.get('revision'), account['name']))
                return self._error(405 if self.command == 'DELETE' else 404, '第一版不提供删除模板版本。' if self.command == 'DELETE' else '模板操作不存在。')
            except TemplateError as error:
                return self._error(error.status, str(error))
            except (ValueError, TypeError):
                return self._error(400, '模板请求无效或内容过大。')
            except (OSError, sqlite3.Error):
                return self._error(503, '模板存储暂不可用，请检查磁盘后重试。')

    def _body_json(self):
            if self.headers.get('Content-Type', '').split(';', 1)[0].strip().lower() != 'application/json':
                raise ValueError('请使用 JSON 提交。')
            body = json.loads(self.rfile.read(self._length(8192)))
            if not isinstance(body, dict):
                raise ValueError('请求内容须为对象。')
            return body

    def _accounts(self, path, account, cookie):
            if not account:
                return self._error(401, '登录已失效。')
            if account['role'] != 'admin' or account['must_change_password']:
                return self._error(403, '人员管理仅向完成密码修改的管理员开放。')
            identity = self.server.identity
            try:
                if path == '/platform/accounts':
                    if self.command in {'GET', 'HEAD'}:
                        return self._json(200, {'items': identity.list_accounts(cookie)})
                    if self.command == 'POST':
                        result = identity.create_account(cookie, self._body_json(), self.server.settings.provision_account)
                        return self._json(201, result)
                    return self._error(405, '不支持此操作。')
                match = re.fullmatch(r'/platform/accounts/([a-f0-9]{32})(/password)?', path)
                if not match:
                    return self._error(404, '账号接口不存在。')
                if match[2] and self.command == 'POST':
                    body = self._body_json()
                    identity.reset_password(cookie, match[1], body.get('password'))
                    return self._json(200, {'status': 'ok'})
                if not match[2] and self.command == 'PATCH':
                    result = identity.update_account(cookie, match[1], self._body_json(), self.server.settings.provision_account)
                    return self._json(200, result)
                return self._error(405, '第一版不支持删除账号或此操作。')
            except PermissionError as error:
                return self._error(403, str(error))
            except LookupError as error:
                return self._error(404, str(error))
            except ValueError as error:
                return self._error(400, str(error))

    def _handle(self):
            self.connection.settimeout(60)
            try:
                self._dispatch()
            except ValueError:
                self._error(400, "请求内容或地址格式有误。")
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
                pass

    def _error(self, status, message, document=False):
        return self._json(status, {"error":message,"message":message,"code":"platform_access"})

    do_GET = do_HEAD = do_POST = do_PUT = do_PATCH = do_DELETE = _handle

    def _dispatch(self):
        host = self.headers.get('Host')
        if host not in {f'127.0.0.1:{self.server.server_port}',f'localhost:{self.server.server_port}'}:
            return self._error(403,'该入口仅供本机访问。')
        parsed = urlsplit(self.path)
        path = parsed.path
        decoded = unquote(path)
        if parsed.scheme or parsed.netloc or not path.startswith('/') or path.startswith('//') or '\\' in decoded or re.search(r'%2f|%5c|%25',path,re.I) or any(p in {'.','..'} for p in decoded.split('/')) or any(ord(c)<32 for c in decoded):
            return self._error(400,'地址无效。')
        read = self.command in {'GET','HEAD'}
        runner = path.startswith('/platform/runner/')
        if not read and self.headers.get('Origin') != 'http://' + host and not (runner and self.headers.get('Origin') is None):
            return self._error(403,'请求来源与平台入口不一致。')
        if runner: return self._runner_member(parsed)
        identity = self.server.identity
        cookie = self._token()
        if path == '/platform/login' and self.command == 'POST':
            body = self._body_json()
            if not isinstance(body.get('login'),str) or not isinstance(body.get('password'),str):
                return self._error(400,'请输入账号及密码。')
            remember = body.get('remember') is True
            token,status = identity.login(body['login'],body['password'],remember)
            if not token: return self._error(status,'尝试次数过多，请稍后重试。' if status==429 else '账号或密码不正确。')
            if cookie: identity.logout(cookie)
            return self._json(200,{'status':'ok'},self._cookie(token,REMEMBER_AGE if remember else None))
        if path == '/platform/logout' and self.command=='POST':
            if cookie: identity.logout(cookie)
            return self._json(200,{'status':'ok'},self._cookie('',0))
        account = identity.current(cookie)
        if path == '/platform/session' and read:
            return self._json(200,{k:v for k,v in account.items() if k!='experience'}) if account else self._error(401,'登录已失效。')
        if path == '/platform/password' and self.command=='POST':
            if not account: return self._error(401,'登录已失效。')
            body = self._body_json()
            try: identity.change_password(cookie,body.get('old_password'),body.get('password'))
            except PermissionError as error: return self._error(401,str(error))
            return self._json(200,{'status':'ok'},self._cookie('',0))
        if path == '/platform/accounts' or path.startswith('/platform/accounts/'):
            return self._accounts(path,account,cookie)
        if path == V2_TEMPLATE_PREFIX or path.startswith(V2_TEMPLATE_PREFIX+'/'):
            return self._templates(parsed,account,cookie)
        if path == EXHIBITION_PREFIX or path.startswith(EXHIBITION_PREFIX + '/'):
            return self._exhibitions(parsed, account, cookie)
        if path == '/platform/v2/planning-dashboard':
            if not account: return self._error(401, '请登录平台。')
            if account['must_change_password'] or 'bg' not in account['modules']:
                return self._error(403, '当前账号没有企划模块访问权限。')
            if not read: return self._error(405, '历史统计仅支持读取。')
            try:
                return self._json(200, snapshot_dashboard(self.server.settings.data, account['id'], parsed.query))
            except LedgerError as error:
                return self._error(error.status, str(error))
            except (OSError, sqlite3.Error, ValueError, KeyError):
                return self._error(503, '统计结果不可用，请核查已迁入的历史数据。')
        if path.startswith('/ai/'):
            if not account: return self._error(401,'请登录平台。')
            if account['must_change_password'] or 'ai' not in account['modules']: return self._error(403,'当前账号无调度权限。')
            rest = path[3:]
            if rest in {'/','/index.html','/login','/login.html','/login.js','/login.css'}:
                return self._error(404,'请从 V2 调度中心访问。')
            if not read and rest in {'/api/service/listen','/api/service/autostart','/api/service/stop','/api/system/restart','/api/system/update/apply','/api/system/update/rollback','/api/system/update/settings'}:
                return self._error(409,'服务生命周期由 V2 启动器管理。')
            return self._proxy('ai',parsed,rest,account,cookie,False)
        if read:
            dist = (ROOT / 'web/dist').resolve()
            relative = path.removeprefix('/v2/') if path.startswith('/v2/') else path.lstrip('/')
            if path=='/v2': return self._headers(303,None,0,(('Location','/v2/'),))
            candidate = (dist / (relative or 'index.html')).resolve()
            if candidate.is_relative_to(dist) and candidate.is_file(): return self._file(candidate)
        return self._error(404,'资源不存在，请先构建 V2 前端。')
