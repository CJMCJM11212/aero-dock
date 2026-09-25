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
    parser.add_argument("--work", nargs=4, type=int)
    parser.add_argument("--bounds", nargs=4, type=int)
    args = parser.parse_args()
    guard.enable_monitor_dpi()
    if args.watch:
        return guard.watch_parent(args.watch, args.work, args.bounds)
    target = str(Path(args.exe).resolve()).casefold()
    if not Path(target).is_file():
        raise SystemExit("Development executable missing")
    mutex = guard.kernel32.CreateMutexW(None, False, "Local\\ZeuslapDockGuard")
    if not mutex or ctypes.get_last_error() == guard.ERROR_ALREADY_EXISTS:
        return
    original_work = original_bounds = None
    try:
        display = guard.target_display()
        bars = guard.target_taskbars(display) if display else []
        if len(bars) != 1:
            raise RuntimeError("ZEUSLAP taskbar was not found uniquely")
        original_work, original_bounds = bars[0]["work"], bars[0]["bounds"]
        subprocess.Popen([sys.executable, __file__, "--watch", str(__import__('os').getpid()),
                          "--work", *map(str, original_work), "--bounds", *map(str, original_bounds)],
                         creationflags=subprocess.CREATE_NO_WINDOW)
        while True:
            if guard.target_display() == display:
                entries = guard.windows()
                available = any(w["title"] == "Aero Dock" and w["display"] == display
                                and w["visible"] and not w["minimized"]
                                and process_path(w["pid"]).casefold() == target for w in entries)
                for bar in entries:
                    if bar["class"] == "Shell_SecondaryTrayWnd" and bar["display"] == display:
                        if available:
                            if bar["visible"]:
                                guard.user32.ShowWindow(bar["hwnd"], guard.SW_HIDE)
                            if bar["bounds"] == original_bounds and bar["work"] != bar["bounds"]:
                                guard.set_work_area(bar["bounds"])
                        else:
                            guard.show_target_taskbar(original_work, original_bounds)
            time.sleep(0.75)
    finally:
        guard.show_target_taskbar(original_work, original_bounds)
        guard.kernel32.CloseHandle(mutex)


if __name__ == "__main__":
    main()
