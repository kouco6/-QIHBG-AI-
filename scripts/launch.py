"""Open the running V2 application, or build and start it before opening it."""
import subprocess
import sys
import time
import webbrowser
from pathlib import Path
from urllib.error import URLError
from urllib.request import ProxyHandler, build_opener

ROOT = Path(__file__).resolve().parents[1]


def running_v2(url):
    """Only reuse a server serving this project's current frontend files."""
    opener = build_opener(ProxyHandler({}))
    for name in ('index.html', 'scheduler.html'):
        path = ROOT / 'web' / 'dist' / name
        expected = path.read_bytes() if path.is_file() else None
        try:
            with opener.open(url + ('' if name == 'index.html' else name), timeout=2) as response:
                body = response.read(len(expected) + 1 if expected is not None else 1)
        except URLError as error:
            if name == 'index.html' and isinstance(error.reason, ConnectionRefusedError):
                return False
            raise RuntimeError(f'{url} 无法正常响应，请检查启动终端；未启动第二个实例。') from error
        if expected is None or body != expected:
            raise RuntimeError(f'{url} 已被其他服务占用，或未提供本工程的构建；未启动第二个实例。')
    return True


def open_browser(url):
    print(f'打开 V2.0：{url}', flush=True)
    try:
        if sys.platform == 'darwin':
            opened = subprocess.run(['open', url], check=False).returncode == 0
        else:
            opened = webbrowser.open(url)
        if not opened:
            print('未能自动打开浏览器，请手动打开上方网址。', flush=True)
    except OSError:
        print('未能自动打开浏览器，请手动打开上方网址。', flush=True)


def launch(port=8793, data_dir=None):
    url = f'http://127.0.0.1:{port}/'
    if running_v2(url):
        print('V2.0 已在运行，直接打开网页。', flush=True)
        open_browser(url)
        return 0

    print('正在构建前端（首次会稍慢）…', flush=True)
    subprocess.run([sys.executable, '-B', str(ROOT / 'scripts/build.py')], cwd=ROOT, check=True)
    command = [sys.executable, '-B', str(ROOT / 'scripts/run.py'), '--port', str(port)]
    if data_dir is not None:
        command.extend(['--data-dir', str(data_dir)])
    child = subprocess.Popen(command, cwd=ROOT)
    try:
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if child.poll() is not None:
                raise RuntimeError('服务启动失败，请查看上方报错；浏览器尚未打开。')
            if running_v2(url):
                open_browser(url)
                print('正常使用时请保留本窗口；按 Ctrl+C 停止服务。', flush=True)
                return child.wait()
            time.sleep(.2)
        raise RuntimeError('服务启动超时，请查看上方报错；浏览器尚未打开。')
    finally:
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()


if __name__ == '__main__':
    try:
        raise SystemExit(launch())
    except KeyboardInterrupt:
        raise SystemExit(0)
    except (RuntimeError, OSError, subprocess.CalledProcessError) as error:
        print(f'启动失败：{error}', file=sys.stderr)
        raise SystemExit(1)
