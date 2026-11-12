"""Loopback HTTP entry for the shared workspace and original module services."""

import http.client
import json
import mimetypes
import re
import secrets
import threading
import time
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

from platform_identity import DEFAULT_LOGIN, MODULES, REMEMBER_AGE
from prepare_sources import ROOT


COOKIE = "bg_platform_session"
HOP_HEADERS = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te",
               "trailer", "transfer-encoding", "upgrade"}
REQUEST_HEADERS = {"accept", "accept-language", "content-type", "last-event-id", "range",
                   "if-match", "if-none-match", "if-modified-since", "x-request-id", "x-bg-token",
                   "x-idempotency-key", "user-agent"}
PLATFORM_ASSETS = {"app.js", "style.css", "ai-theme.css", "logo.png"}
AI_OPERATIONS = {"/api/service/listen", "/api/service/autostart", "/api/service/stop",
                 "/api/system/restart", "/api/system/update/apply", "/api/system/update/rollback",
                 "/api/system/update/settings"}
EXP_ORIGINAL_LOGIN = {"/api/v1/auth/setup", "/api/v1/auth/login", "/api/v1/auth/logout"}


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, settings, identity, modules, stop_key):
        self.settings = settings
        self.identity = identity
        self.modules = modules
        self.stop_key = stop_key
        self.launch_tickets = {}
        self.ticket_lock = threading.Lock()
        super().__init__(("127.0.0.1", settings.port), Handler)

    def launch_url(self):
        base = f"http://127.0.0.1:{self.server_port}"
        with self.identity.db() as db:
            account = db.execute("SELECT id FROM account WHERE login=? AND active=1", (DEFAULT_LOGIN,)).fetchone()
        if not account:
            return base + "/"
        ticket = secrets.token_urlsafe(32)
        now = time.monotonic()
        with self.ticket_lock:
            self.launch_tickets = {key: value for key, value in self.launch_tickets.items() if value[1] > now}
            self.launch_tickets[self.identity.digest(ticket)] = (account["id"], now + 60)
        return base + "/platform/enter?ticket=" + ticket

    def redeem_ticket(self, ticket):
        if not ticket or len(ticket) > 64:
            return None
        with self.ticket_lock:
            record = self.launch_tickets.pop(self.identity.digest(ticket), None)
        if not record or record[1] <= time.monotonic():
            return None
        return self.identity.issue_session(record[0], remember=True)


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

    def _error(self, status, message, document=False):
        if document and status == 401:
            self._headers(303, None, 0, (("Location", "/"),))
        elif document:
            template = (ROOT / "portal" / "error.html").read_text(encoding="utf-8")
            payload = template.replace("{{message}}", message).encode()
            self._headers(status, "text/html; charset=utf-8", len(payload))
            if self.command != "HEAD":
                self.wfile.write(payload)
        else:
            self._json(status, {"error": message, "message": message, "code": "platform_access"})

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
        account_key = account["id"] if module in {"bg", "ai"} else None
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
        if module == "ai":
            headers["Authorization"] = f"Bearer {ai_token}"
        else:
            headers["X-Integration-Key"] = self.server.modules.key
        if module == "experience":
            headers["X-Integration-Account"] = account["experience"] or ""
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
                    if not current or current["id"] != account["id"] or module not in current["modules"]:
                        break
                self.wfile.write(chunk)
                if streaming:
                    self.wfile.flush()
        except (OSError, http.client.HTTPException):
            if not sent:
                self._error(502, "业务服务连接已中断。请重试或查看启动日志。", document)
        finally:
            conn.close()

    def _dispatch(self):
        server = self.server
        host = self.headers.get("Host")
        if host not in {f"127.0.0.1:{server.server_port}", f"localhost:{server.server_port}"}:
            return self._error(403, "该入口仅供本机访问。")
        parsed = urlsplit(self.path)
        path = parsed.path
        decoded_path = unquote(path)
        if (parsed.netloc or parsed.scheme or not path.startswith("/") or path.startswith("//")
                or "\\" in decoded_path or any(ord(c) < 32 for c in decoded_path)
                or re.search(r"%2f|%5c|%25", path, re.IGNORECASE)
                or any(part in (".", "..") for part in decoded_path.split("/"))):
            return self._error(400, "地址无效。")
        read = self.command in {"GET", "HEAD"}
        if path in {"/platform/control/stop", "/platform/control/status", "/platform/control/open"}:
            secret = self.headers.get("X-Platform-Control", "")
            if not secrets.compare_digest(secret, server.stop_key):
                return self._error(403, "无法验证本地控制命令。")
            if path.endswith("/status") and read:
                services = {f"{module}:{account or 'shared'}": child.poll() is None
                            for (module, account), (_, _, child) in dict(server.modules.children).items()}
                return self._json(200, {"status": "ok", "services": services})
            if path.endswith("/stop") and self.command == "POST":
                self._json(200, {"status": "stopping"})
                threading.Thread(target=server.shutdown, daemon=True).start()
                return
            if path.endswith("/open") and self.command == "POST":
                return self._json(200, {"url": server.launch_url()})
            return self._error(405, "操作方法无效。")
        if not read and self.headers.get("Origin") != f"http://{host}":
            return self._error(403, "请求来源与平台入口不一致。")
        identity = server.identity
        cookie = self._token()
        if path == "/platform/enter" and self.command == "GET":
            ticket = parse_qs(parsed.query).get("ticket", [""])[0]
            token = server.redeem_ticket(ticket)
            if not token:
                return self._error(403, "启动链接已失效，请再次双击启动平台。", True)
            if cookie:
                identity.logout(cookie)
            return self._headers(303, None, 0, (*self._cookie(token, REMEMBER_AGE), ("Location", "/")))
        if path == "/platform/login" and self.command == "POST":
            body = json.loads(self.rfile.read(self._length(8192)))
            if not isinstance(body, dict) or not isinstance(body.get("login"), str) or not isinstance(body.get("password"), str):
                return self._error(400, "请输入平台账号和密码。")
            remember = body.get("remember") is True
            token, status = identity.login(body["login"], body["password"], remember)
            if not token:
                return self._error(status, "尝试次数过多，请稍后重试。" if status == 429 else "账号或密码不正确。")
            if cookie:
                identity.logout(cookie)
            return self._json(200, {"status": "ok"}, self._cookie(token, REMEMBER_AGE if remember else None))
        if path == "/platform/logout" and self.command == "POST":
            if cookie:
                identity.logout(cookie)
            return self._json(200, {"status": "ok"}, self._cookie("", 0))
        account = identity.current(cookie)
        if path == "/platform/session" and read:
            if not account:
                return self._error(401, "登录已失效。")
            return self._json(200, {key: account[key] for key in ("id", "name", "modules")})
        if read and (path == "/" or path in {f"/work/{m}" for m in MODULES}):
            return self._file(ROOT / "portal" / "index.html")
        if read and path.startswith("/platform/") and path.split("/")[-1] in PLATFORM_ASSETS:
            return self._file(ROOT / "portal" / path.split("/")[-1])
        parts = path.split("/", 2)
        module = parts[1] if len(parts) > 1 else ""
        if module not in MODULES:
            return self._error(404, "页面不存在。", self.headers.get("Sec-Fetch-Mode") == "navigate")
        rest = "/" + (parts[2] if len(parts) == 3 else "")
        document = read and (self.headers.get("Sec-Fetch-Mode") == "navigate" or
                             rest == "/" or "text/html" in self.headers.get("Accept", ""))
        if not account:
            return self._error(401, "登录已失效。", document)
        if module not in account["modules"]:
            return self._error(403, "当前账号没有此模块的访问权限。", document)
        if len(parts) == 2 and read:
            return self._headers(308, None, 0, (("Location", f"/{module}/"),))
        if module == "ai" and rest in AI_OPERATIONS and not read:
            return self._error(409, "监听、启动及软件更新由三合一平台统一管理。")
        if module == "experience":
            if rest in EXP_ORIGINAL_LOGIN:
                return self._error(409, "请使用统一平台登录与退出。")
            if not rest.startswith("/api/"):
                if not read:
                    return self._error(405, "操作方法无效。")
                dist = server.settings.runtime / "experience/frontend/dist"
                candidate = dist / unquote(rest.lstrip("/"))
                if candidate.is_file() and candidate.resolve().is_relative_to(dist):
                    return self._file(candidate)
                if "." in Path(rest).name:
                    return self._error(404, "资源不存在。")
                return self._file(dist / "index.html")
        return self._proxy(module, parsed, rest, account, cookie, document)

    def _handle(self):
        self.connection.settimeout(60)
        try:
            self._dispatch()
        except ValueError:
            self._error(400, "请求内容或地址格式有误。")
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass

    do_GET = do_HEAD = do_POST = do_PUT = do_PATCH = do_DELETE = _handle
