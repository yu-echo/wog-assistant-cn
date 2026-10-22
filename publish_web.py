# -*- coding: utf-8 -*-
"""把运行时文件同步到 _web/（对外托管的干净目录）。

项目根目录里有十几份 .bak 备份、dist/build 打包产物、download 里的 11MB exe，
这些东西不需要上传。这个脚本只复制真正跑页面要用到的文件，保持目录结构不变。

用法：python publish_web.py
产物：_web/  （然后用 sites 部署这个目录）
"""
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "_web")

SKIP_DIRS = {"_web", "dist", "build", "download", "__pycache__", ".git", ".workbuddy"}
EXT_OK = {".js", ".css", ".json", ".woff2", ".png", ".svg", ".html"}


def keep(name):
    """只要真正的运行时文件：跳过所有备份和 sourcemap。"""
    if ".bak" in name or name.endswith(".map"):
        return False
    return os.path.splitext(name)[1].lower() in EXT_OK


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT)

    copied = []
    for name in sorted(os.listdir(ROOT)):
        src = os.path.join(ROOT, name)
        if not os.path.isfile(src) or not keep(name):
            continue
        shutil.copy2(src, os.path.join(OUT, name))
        copied.append((name, os.path.getsize(src)))

    for d in ("js", "_astro"):
        sdir = os.path.join(ROOT, d)
        if not os.path.isdir(sdir):
            continue
        os.makedirs(os.path.join(OUT, d), exist_ok=True)
        for name in sorted(os.listdir(sdir)):
            src = os.path.join(sdir, name)
            if not os.path.isfile(src) or not keep(name):
                continue
            shutil.copy2(src, os.path.join(OUT, d, name))
            copied.append((d + "/" + name, os.path.getsize(src)))

    total = sum(s for _, s in copied)
    print("同步 %d 个文件，共 %.2f MB -> %s\n" % (len(copied), total / 1048576.0, OUT))
    for n, s in copied:
        print("  %-72s %7.1f KB" % (n, s / 1024.0))

    must = ["index.html", "js/wog-companion.js", "js/wog-connector.js", "js/wog-db.js"]
    missing = [m for m in must if not os.path.exists(os.path.join(OUT, m))]
    if missing:
        print("\n!! 缺少必需文件: %s" % ", ".join(missing))
        return 1
    print("\n必需文件齐全。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
