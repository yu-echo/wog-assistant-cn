# -*- coding: utf-8 -*-
"""打包成单文件 exe（排除 .bak 备份，避免体积翻倍）。

用法：python build_exe.py
产物：dist/山猪WoG助手.exe
"""
import glob
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)


def collect():
    items = []
    # 单个文件
    for f in ("index.html",):
        if os.path.exists(f):
            items.append((f, "."))
    # js / _astro：只要真正的运行时文件，跳过 .bak*
    for d in ("js", "_astro"):
        if not os.path.isdir(d):
            continue
        for f in sorted(os.listdir(d)):
            full = os.path.join(d, f)
            if not os.path.isfile(full):
                continue
            if ".bak" in f or f.endswith(".map"):
                continue
            if not f.lower().endswith((".js", ".css", ".json", ".woff2", ".png", ".svg")):
                continue
            items.append((full, d))
    return items


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    data = collect()
    total = sum(os.path.getsize(p) for p, _ in data)
    print("要打入的文件 %d 个，共 %.1f MB：" % (len(data), total / 1048576.0))
    for p, d in data:
        print("   %-70s -> %s" % (p, d))

    if os.path.isdir("dist"):
        shutil.rmtree("dist", ignore_errors=True)

    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm", "--clean", "--onefile",
        "--name", "山猪WoG助手",
        "--console",
        "--workpath", "build",
        "--specpath", "build",
    ]
    for p, d in data:
        cmd += ["--add-data", "%s;%s" % (os.path.abspath(p), d)]
    cmd += ["launcher.py"]

    print("\n开始打包…\n")
    r = subprocess.run(cmd)
    if r.returncode != 0:
        print("打包失败，返回码 %d" % r.returncode)
        return 1

    exe = os.path.join("dist", "山猪WoG助手.exe")
    if not os.path.exists(exe):
        print("没找到产物 %s" % exe)
        return 1
    print("\n完成：%s（%.1f MB）" % (exe, os.path.getsize(exe) / 1048576.0))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
