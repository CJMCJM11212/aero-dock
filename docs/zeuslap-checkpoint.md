# ZEUSLAP dock checkpoint - 2026-09-25

## Accepted changes

- Resize keeps a fixed origin, coalesces native updates, preserves capture,
  and saves size and position together. Grip hover does not change geometry.
- Overlay space is reserved in a fixed WebView canvas. Opening/closing menus
  changes the native clipping region, not the window origin or dimensions.
  Closed reserved space passes input through to the underlying window.
- File/shortcut drops reveal an insertion slot. New pins retain shortcut
  arguments and icon sources; duplicate checks include launch arguments.
- Context menus use Korean labels and neutral rounded surfaces.
- Opaque square icons fill the rounded tile without an extra white frame;
  transparent icons retain their padded background.
- WebView GPU acceleration is enabled. Immersive foreground applications
  suspend animations, application scanning and system status polling.
- The development taskbar helper hides only the APT1601 secondary taskbar,
  restores it when the development dock is unavailable, and survives rebuilds.

## Runtime / continuation

- Continue in branch `codex/zeuslap-fast-glass-game-603c9fbc9b8b`.
- Canonical source: `C:\Users\User\Documents\AeroDock\source`.
- This worktree: `C:\Users\User\Documents\AeroDock\source-worktrees\zeuslap-fast-glass-game-603c9fbc9b8b`.
- Development command: `pnpm tauri dev --release --config .temp/tauri-preview.json`.
  The local override sets identifier `com.aerodock.preview603c9fbc9b8b` and
  productName `Aero Dock Preview`; `AERO_DOCK_PREVIEW=1` is required.
- Vite port 1420, WebView debug port 9223. Preview settings are under
  `%APPDATA%\com.aerodock.preview603c9fbc9b8b`.
- The running executable uses the existing shared Cargo target under
  `source-worktrees\zeuslap-icons-7a6df7e4d0a0\src-tauri\target\release`.
  That build-output path is not the source checkout.
- `scripts/zeuslap-preview-taskbar.py --exe <verified-development-executable>`
  reuses the monitor identification from the installed ZeuslapDockGuard helper.
  It must not run concurrently with the packaged dock's guard.

## Verification

- Native development build and `pnpm typecheck` passed.
- Resize: 29 focused live assertions passed, including hover, grow/shrink,
  reverse direction, release, cancellation and saved geometry readback.
- Menu open/close: six complete cycles, 259 native screen samples,
  no native rectangle changes or DOM anchor changes. Clipped reserved area
  was confirmed to hit the underlying window; the shelf remained interactive.
- Drop/add/duplicate handling was checked through injected Tauri drag events,
  not a new physical Explorer drag.
- Discord's 256px shortcut icon and `--processStart Discord.exe` arguments
  were repaired on the existing pin and verified after reload.
- Opaque BeautyTax icon rendering was visually checked in the live dock;
  Explorer, terminal, Notepad and Discord retained their transparent-icon style.

## Remaining boundaries

- This is a development checkpoint, not a packaged release or canonical merge.
- The shelf is neutral translucent; real desktop background blur is not implemented.
- Immersive pause was implemented and its event path checked; a physical game
  session has not been used to verify the full detection/resume flow.
- Live settings, icon caches, captured videos and temporary diagnostics are local
  state and must not be committed or overwritten during release work.
