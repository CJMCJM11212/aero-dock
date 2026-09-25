"""Bind the existing ZEUSLAP-only taskbar guard to this development executable."""
import argparse
import ctypes
import importlib.util
from pathlib import Path
import subprocess
import sys
import time
from ctypes import wintypes

spec = importlib.util.spec_from_file_location("zeuslap_guard", r"C:\Users\User\Documents\ZeuslapDockGuard\guard.py")
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


def process_path(pid):
    handle = guard.kernel32.OpenProcess(0x1000, False, pid)
    if not handle:
        return ""
    try:
        value = ctypes.create_unicode_buffer(32768)
        length = wintypes.DWORD(len(value))
        return value.value if query_path(handle, 0, value, ctypes.byref(length)) else ""
    finally:
        guard.kernel32.CloseHandle(handle)


query_path = guard.kernel32.QueryFullProcessImageNameW
query_path.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
query_path.restype = wintypes.BOOL


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe")
    parser.add_argument("--watch", type=int)
    args = parser.parse_args()
    guard.enable_monitor_dpi()
    if args.watch:
        return guard.watch_parent(args.watch)
    target = str(Path(args.exe).resolve()).casefold()
    if not Path(target).is_file():
        raise SystemExit("Development executable missing")
    mutex = guard.kernel32.CreateMutexW(None, False, "Local\\ZeuslapDockGuard")
    if not mutex or ctypes.get_last_error() == guard.ERROR_ALREADY_EXISTS:
        return
    try:
        subprocess.Popen([sys.executable, __file__, "--watch", str(__import__('os').getpid())],
                         creationflags=subprocess.CREATE_NO_WINDOW)
        while True:
            display = guard.target_display()
            if display:
                entries = guard.windows()
                available = any(w["title"] == "Aero Dock" and w["display"] == display
                                and w["visible"] and not w["minimized"]
                                and process_path(w["pid"]).casefold() == target for w in entries)
                for bar in entries:
                    if bar["class"] == "Shell_SecondaryTrayWnd" and bar["display"] == display:
                        if bar["visible"] == available:
                            guard.user32.ShowWindow(bar["hwnd"], guard.SW_HIDE if available else guard.SW_SHOWNA)
            time.sleep(0.75)
    finally:
        guard.show_target_taskbar()
        guard.kernel32.CloseHandle(mutex)


if __name__ == "__main__":
    main()
