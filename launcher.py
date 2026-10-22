# -*- coding: utf-8 -*-
"""exe 入口：起本地服务并打开浏览器。

打包后 sys._MEIPASS 是解包目录，start.py 里的 ROOT 自动指向它，
静态文件（index.html / js / _astro）都在那里，所以不需要额外改路径。
"""
import os
import sys

BASE = getattr(sys, "_MEIPASS", None) or os.path.dirname(os.path.abspath(__file__))
if BASE not in sys.path:
    sys.path.insert(0, BASE)

try:
    import start
except Exception as exc:  # 起不来也要让用户看见原因，不能一闪而过
    print("启动失败：%s" % exc)
    input("按回车关闭…")
    raise SystemExit(1)

start.main()
