# ZEUSLAP Aero Dock fork

This is the source for the local Aero Dock portable runtime at
`C:\Users\User\Documents\AeroDock\Aero Dock 1.2.2`.

## Build and checks

- Frontend: `pnpm install --frozen-lockfile`, then `pnpm typecheck` and `pnpm build`.
- Native app: `pnpm tauri build` with the Windows MSVC Rust toolchain.
- The live portable folder uses `portable.txt` and stores its settings and icon cache in `data`.

## Live boundaries

- Preserve `data/settings.json`, `data/icons`, and `data/webview` during binary updates.
- The ZEUSLAP-only taskbar behavior is owned by `C:\Users\User\Documents\ZeuslapDockGuard\guard.py` and targets the `APT1601` display. Do not enable Aero Dock's global `hideTaskbar` setting.
- Confirm the exact running Aero Dock executable and the guard before replacing or restarting the live binary.
