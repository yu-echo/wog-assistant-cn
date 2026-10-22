# -*- coding: utf-8 -*-
"""10998 端口内存补丁（网页助手内置）。

原理：游戏里 Puerts Inspector 的监听端口被写死成 -1（不启动），
      在 GameAssembly.dll 里对应一条 `mov edx, imm32`。把 imm32 改成 10998 即可。
      这里改的是**运行中进程的内存**，不动磁盘文件、不改游戏目录，
      关掉游戏就自动恢复，不需要备份与还原。

安全策略：
  - 特征码定位，不写死偏移（游戏小更新后仍可跟随）
  - 只在读到确定的原始字节 `ba ff ff ff ff` 时才写；读不到/不符一律拒绝
  - 已打补丁则直接返回，不重复写
"""

from __future__ import annotations

import ctypes
import os
import re
import socket
import struct
import subprocess
from ctypes import wintypes
from pathlib import Path

SIG = re.compile(
    rb"\x83\xb8\xe4\x00\x00\x00\x00\x75\x0f\x48\x8b\xc8\xe8...."
    rb"\x48\x8b\x05....\x48\x8b\x80\xb8\x00\x00\x00\x48\x8b\x48\x20"
    rb"\x45\x33\xc0\xba....\xe8....\x48\x8b\xf8\x48"
)
BA_IN_SIG = 38                      # 特征码起点到 `ba` 的偏移
PORT = 10998
CURRENT_IMMEDIATE = b"\xff\xff\xff\xff"
PATCHED_IMMEDIATE = struct.pack("<I", PORT)   # f6 2a 00 00
PROCESS_NAME = "Genesis.exe"
MODULE_NAME = "GameAssembly.dll"

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

PROCESS_VM_READ = 0x0010
PROCESS_VM_WRITE = 0x0020
PROCESS_VM_OPERATION = 0x0008
PROCESS_QUERY_INFORMATION = 0x0400
TH32CS_SNAPMODULE = 0x00000008
TH32CS_SNAPMODULE32 = 0x00000010
PAGE_EXECUTE_READWRITE = 0x40
INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
MAX_PATH = 260


class PatchError(RuntimeError):
    pass


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD), ("th32DefaultHeapID", ctypes.c_void_p),
        ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
        ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", wintypes.DWORD), ("szExeFile", wintypes.WCHAR * MAX_PATH),
    ]


class MODULEENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD), ("th32ModuleID", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD), ("GlblcntUsage", wintypes.DWORD),
        ("ProccntUsage", wintypes.DWORD), ("modBaseAddr", ctypes.c_void_p),
        ("modBaseSize", wintypes.DWORD), ("hModule", ctypes.c_void_p),
        ("szModule", wintypes.WCHAR * 256), ("szExePath", wintypes.WCHAR * MAX_PATH),
    ]


def _find_pid(name: str = PROCESS_NAME) -> int:
    snap = kernel32.CreateToolhelp32Snapshot(0x00000002, 0)   # TH32CS_SNAPPROCESS
    if snap == INVALID_HANDLE_VALUE:
        raise PatchError("无法枚举进程")
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(entry)
        ok = kernel32.Process32FirstW(snap, ctypes.byref(entry))
        while ok:
            if entry.szExeFile.lower() == name.lower():
                return int(entry.th32ProcessID)
            ok = kernel32.Process32NextW(snap, ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(snap)
    return 0


def _module_base(pid: int, name: str = MODULE_NAME):
    snap = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid)
    if snap == INVALID_HANDLE_VALUE:
        raise PatchError("无法枚举游戏模块（可能权限不足）")
    try:
        entry = MODULEENTRY32W()
        entry.dwSize = ctypes.sizeof(entry)
        ok = kernel32.Module32FirstW(snap, ctypes.byref(entry))
        while ok:
            if entry.szModule.lower() == name.lower():
                return int(entry.modBaseAddr), int(entry.modBaseSize), entry.szExePath
            ok = kernel32.Module32NextW(snap, ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(snap)
    return 0, 0, ""


def find_game_dir() -> Path:
    """定位游戏根目录（含 GameAssembly.dll 与 Genesis_Data）。

    优先用运行中进程加载的模块路径——最准；其次环境变量；最后扫 Steam 库。
    """
    pid = _find_pid()
    if pid:
        try:
            base, _size, dll_path = _module_base(pid)
            if base and dll_path:
                directory = Path(dll_path).parent
                if (directory / MODULE_NAME).is_file():
                    return directory
        except PatchError:
            pass
    candidates = []
    configured = os.environ.get("WOG_GAME_DIR")
    if configured:
        candidates.append(Path(configured).expanduser())
    steam_roots = [
        Path(os.environ.get("ProgramFiles(x86)", "C:/Program Files (x86)")) / "Steam",
        Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Steam",
    ]
    try:
        import winreg
        for hive, key in ((winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam"),
                          (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Valve\Steam")):
            try:
                with winreg.OpenKey(hive, key) as handle:
                    candidates.append(Path(winreg.QueryValueEx(handle, "SteamPath")[0]))
            except OSError:
                pass
    except ImportError:
        pass
    for steam_root in list(steam_roots) + candidates[1:]:
        if not steam_root or not steam_root.is_dir():
            continue
        candidates.append(steam_root / "steamapps" / "common" / "War of Genesis Idle Loot")
        vdf = steam_root / "steamapps" / "libraryfolders.vdf"
        if vdf.is_file():
            for raw in re.findall(r'"path"\s+"([^"]+)"', vdf.read_text(encoding="utf-8", errors="ignore")):
                candidates.append(Path(raw.replace("\\\\", "\\")) / "steamapps" / "common" / "War of Genesis Idle Loot")
    for base in candidates:
        for directory in (base, *base.parents):
            try:
                if (directory / MODULE_NAME).is_file() and (directory / "Genesis_Data").is_dir():
                    return directory
            except OSError:
                continue
    raise PatchError("找不到游戏安装目录；可设置环境变量 WOG_GAME_DIR 指向游戏根目录")


def locate(data: bytes) -> int:
    hits = [m.start() + BA_IN_SIG for m in SIG.finditer(data)]
    if len(hits) != 1:
        raise PatchError("无法唯一定位端口指令（命中 %d 处），游戏可能已大改版" % len(hits))
    return hits[0]


def file_off_to_rva(data: bytes, off: int) -> int:
    if data[:2] != b"MZ":
        raise PatchError("GameAssembly.dll 不是有效 PE 文件")
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    if data[pe:pe + 4] != b"PE\0\0":
        raise PatchError("PE 头损坏")
    count = struct.unpack_from("<H", data, pe + 6)[0]
    opt_size = struct.unpack_from("<H", data, pe + 20)[0]
    table = pe + 24 + opt_size
    for i in range(count):
        s = table + i * 40
        vsize, vaddr = struct.unpack_from("<II", data, s + 8)
        raw_size, raw_ptr = struct.unpack_from("<II", data, s + 16)
        if raw_ptr <= off < raw_ptr + max(raw_size, vsize):
            return off - raw_ptr + vaddr
    raise PatchError("定位到的偏移不在任何节区里")


def port_open(port: int = PORT, timeout: float = 0.35) -> bool:
    s = socket.socket()
    s.settimeout(timeout)
    try:
        return s.connect_ex(("127.0.0.1", port)) == 0
    finally:
        s.close()


def status() -> dict:
    pid = _find_pid()
    result = {
        "game_running": bool(pid),
        "pid": pid,
        "port_open": port_open(),
        "patched": False,
        "reason": "",
    }
    if result["port_open"]:
        result["patched"] = True
        result["reason"] = "10998 已在监听"
        return result
    if not pid:
        result["reason"] = "游戏未运行"
        return result
    try:
        base, size, dll_path = _module_base(pid)
    except PatchError as exc:
        result["reason"] = str(exc)
        return result
    if not base:
        result["reason"] = "游戏里找不到 GameAssembly.dll"
        return result
    try:
        game_dir = find_game_dir()
        data = (game_dir / MODULE_NAME).read_bytes()
        off = locate(data)
        rva = file_off_to_rva(data, off)
        raw = read_memory(pid, base + rva, 5)
        if raw[0:1] == b"\xba" and raw[1:5] == PATCHED_IMMEDIATE:
            result["patched"] = True
            result["reason"] = "内存已是 10998（可能尚未监听完成）"
        elif raw[0:1] == b"\xba" and raw[1:5] == CURRENT_IMMEDIATE:
            result["patched"] = False
            result["reason"] = "检测到未注入"
        else:
            result["reason"] = "内存字节不符：%s" % raw.hex()
    except PatchError as exc:
        result["reason"] = str(exc)
    return result


def _open(pid: int):
    handle = kernel32.OpenProcess(
        PROCESS_VM_READ | PROCESS_VM_WRITE | PROCESS_VM_OPERATION | PROCESS_QUERY_INFORMATION, False, pid)
    if not handle:
        err = ctypes.get_last_error()
        if err == 5:
            raise PatchError("游戏进程拒绝访问，请以管理员身份运行「启动.cmd」")
        raise PatchError("打开游戏进程失败（错误码 %d）" % err)
    return handle


def read_memory(pid: int, address: int, size: int) -> bytes:
    handle = _open(pid)
    try:
        buf = ctypes.create_string_buffer(size)
        read = ctypes.c_size_t(0)
        if not kernel32.ReadProcessMemory(handle, ctypes.c_void_p(address), buf, size, ctypes.byref(read)):
            raise PatchError("读取游戏内存失败（错误码 %d）" % ctypes.get_last_error())
        return buf.raw[:read.value]
    finally:
        kernel32.CloseHandle(handle)


def apply() -> dict:
    # 注意：不能用「端口是否监听」当唯一判据 —— socket 是游戏启动时 bind 的，
    # 改内存里的端口常量并不会关掉已经监听的端口；反过来端口通也可能内存不是 10998。
    # 所以先按内存真实字节判断，端口只用来给提示。
    pid = _find_pid()
    if not pid:
        raise PatchError("游戏没运行，请先启动 War of Genesis: Idle Loot")

    base, size, dll_path = _module_base(pid)
    if not base:
        raise PatchError("游戏里找不到 GameAssembly.dll")

    game_dir = find_game_dir()
    data = (game_dir / MODULE_NAME).read_bytes()
    off = locate(data)
    rva = file_off_to_rva(data, off)
    address = base + rva

    handle = _open(pid)
    try:
        current = read_memory(pid, address, 5)
        if current[0:1] != b"\xba":
            raise PatchError("目标位置不是预期指令（读到 %s），已中止" % current.hex())
        if current[1:5] == PATCHED_IMMEDIATE:
            return {"ok": True, "changed": False,
                    "message": "内存已是 10998" + ("，端口已通" if port_open() else "，等待游戏开始监听")}
        if current[1:5] != CURRENT_IMMEDIATE:
            if port_open():
                # 内存不是标准值但端口在监听：能用就别动它
                return {"ok": True, "changed": False, "message": "10998 已在监听（内存非标准值，未改动）"}
            raise PatchError("目标立即数不是 -1（读到 %s），已中止" % current.hex())

        old_protect = wintypes.DWORD(0)
        if not kernel32.VirtualProtectEx(handle, ctypes.c_void_p(address), 5,
                                         PAGE_EXECUTE_READWRITE, ctypes.byref(old_protect)):
            raise PatchError("修改内存保护失败（错误码 %d）" % ctypes.get_last_error())
        try:
            payload = b"\xba" + PATCHED_IMMEDIATE
            written = ctypes.c_size_t(0)
            if not kernel32.WriteProcessMemory(handle, ctypes.c_void_p(address), payload, 5, ctypes.byref(written)):
                raise PatchError("写入游戏内存失败（错误码 %d）" % ctypes.get_last_error())
        finally:
            kernel32.VirtualProtectEx(handle, ctypes.c_void_p(address), 5,
                                      old_protect.value, ctypes.byref(wintypes.DWORD(0)))
        kernel32.FlushInstructionCache(handle, ctypes.c_void_p(address), 5)

        verify = read_memory(pid, address, 5)
        if verify[1:5] != PATCHED_IMMEDIATE:
            raise PatchError("写入后校验失败（当前 %s）" % verify.hex())
    finally:
        kernel32.CloseHandle(handle)

    return {
        "ok": True,
        "changed": True,
        "address": hex(address),
        "rva": hex(rva),
        "file_offset": off,
        "message": "注入成功，10998 已开启",
    }


if __name__ == "__main__":
    import json
    print(json.dumps(status(), ensure_ascii=False, indent=2))
