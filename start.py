# -*- coding: utf-8 -*-
"""山猪 WoG 助手本地启动器：静态服务 + 内置 10998 注入接口。

页面里的「注入」按钮会 POST /api/patch，本进程给运行中的游戏打内存补丁，
不需要下载任何 Connector，也不改游戏文件。
"""
import http.server
import json
import os
import socket
import socketserver
import threading
import urllib.request
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)

# 固定端口：浏览器 localStorage 是按「协议+主机+端口」隔离的，
# 端口每次变，用户存的设置就等于全丢，所以这里钉死一个端口。
FIXED_PORT = 8791
PORT_TRIES = 20

try:
    import wogpatch
except Exception:  # 补丁模块坏了也不能影响页面打开
    wogpatch = None


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def port_free(port):
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        s.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def is_our_instance(port):
    """这个端口上跑的是不是已经开着的助手本体。"""
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/api/status" % port, timeout=1.2) as r:
            data = json.loads(r.read().decode("utf-8"))
        return "patched" in data and "game_running" in data
    except Exception:
        return False


def pick_port():
    """优先 8791；被别的程序占了才往后顺延，最差退回随机端口。"""
    for p in range(FIXED_PORT, FIXED_PORT + PORT_TRIES):
        if port_free(p):
            return p
    return free_port()


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        pass  # 静默日志

    # ---------- 工具 ----------
    def _send_json(self, payload, code=200, cors=False):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if cors:
            # 只读状态接口允许跨域：托管在公网的页面要靠它判断本地版有没有在跑。
            # 写入接口不开放跨域，见 _api_patch 的 Origin 校验。
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()
        self.wfile.write(body)

    def _same_origin(self):
        """写入接口只接受同源调用，避免随便哪个网页都能指挥本机注入。"""
        origin = self.headers.get("Origin")
        if not origin:
            return True
        host = (self.headers.get("Host") or "").strip().lower()
        return origin.split("://", 1)[-1].rstrip("/").lower() == host

    # ---------- 路由 ----------
    def do_OPTIONS(self):
        if self.path.split("?")[0] == "/api/status":
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "*")
            self.send_header("Access-Control-Max-Age", "600")
            self.end_headers()
            return
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        if self.path.split("?")[0] == "/api/status":
            return self._api_status()
        return super().do_GET()

    def do_POST(self):
        path = self.path.split("?")[0]
        if path == "/api/patch":
            return self._api_patch()
        if path == "/api/status":
            return self._api_status()
        self._send_json({"ok": False, "message": "未知接口"}, 404)

    def _api_status(self):
        if wogpatch is None:
            return self._send_json({"ok": False, "patched": False, "game_running": False,
                                    "message": "补丁模块加载失败"}, cors=True)
        try:
            st = wogpatch.status()
            st["ok"] = True
            self._send_json(st, cors=True)
        except Exception as exc:
            self._send_json({"ok": False, "patched": False, "game_running": False,
                             "message": str(exc)}, cors=True)

    def _api_patch(self):
        if not self._same_origin():
            return self._send_json({"ok": False, "message": "跨站请求已拒绝"}, 403)
        if wogpatch is None:
            return self._send_json({"ok": False, "message": "补丁模块加载失败"}, 500)
        try:
            result = wogpatch.apply()
            result["ok"] = True
            self._send_json(result)
        except Exception as exc:
            self._send_json({"ok": False, "message": str(exc)}, 200)


def main():
    # 端口上已经有一个开着的助手：直接打开它，不要另起一个（另起会换端口、丢设置）
    if not port_free(FIXED_PORT) and is_our_instance(FIXED_PORT):
        url = f"http://127.0.0.1:{FIXED_PORT}/index.html"
        print(f"助手已经在运行：{url}")
        print("（直接打开这个地址即可，设置和存档都在里面）")
        webbrowser.open(url)
        return

    port = pick_port()
    url = f"http://127.0.0.1:{port}/index.html"
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", port), Handler)
    threading.Timer(0.7, lambda: webbrowser.open(url)).start()
    print(f"山猪 WoG 助手已启动：{url}")
    print("（关掉这个窗口即停止服务；游戏里缺 10998 时，网页弹窗点「注入」即可）")
    print(f"（地址固定为 127.0.0.1:{FIXED_PORT}，功能开关和存档设置会一直保留）")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
