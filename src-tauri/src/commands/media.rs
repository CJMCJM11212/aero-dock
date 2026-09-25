//! The independent media card: Windows owns its rectangle during a gesture.
//! Persist only the final rectangle, so no settings event can reposition it
//! while a finger is still moving.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::WindowsAndMessaging::{GetWindowRect, SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER};

use crate::core::{AeroError, AeroResult};
use crate::core::settings::SettingsStore;
use crate::platform::windows::media::{self, MediaAction, MediaInfo};
use crate::platform::windows::monitors::{enumerate_monitors, pick_monitor, MonitorInfoEx, Rect};
use crate::platform::windows::system::{self, MicrophoneStatus, VolumeStatus};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaStatus {
    pub media: MediaInfo,
    pub volume: VolumeStatus,
    pub microphone: MicrophoneStatus,
}

#[tauri::command]
pub async fn get_media_status() -> AeroResult<MediaStatus> {
    tauri::async_runtime::spawn_blocking(|| MediaStatus {
        media: media::read_media(),
        volume: system::read_volume().unwrap_or_default(),
        microphone: system::microphone_status().unwrap_or_default(),
    }).await.map_err(|e| AeroError::other(format!("media status task failed: {e}")))
}

#[tauri::command]
pub async fn control_media(action: String) -> AeroResult<bool> {
    let action = match action.as_str() {
        "previous" => MediaAction::Previous,
        "toggle" => MediaAction::Toggle,
        "next" => MediaAction::Next,
        _ => return Err(AeroError::other("invalid media action")),
    };
    tauri::async_runtime::spawn_blocking(move || media::control(action))
        .await.map_err(|e| AeroError::other(format!("media control task failed: {e}")))?
}

#[tauri::command]
pub async fn set_microphone_mute(mute: bool) -> AeroResult<MicrophoneStatus> {
    tauri::async_runtime::spawn_blocking(move || system::set_microphone_mute(mute))
        .await.map_err(|e| AeroError::other(format!("microphone task failed: {e}")))?
}

#[derive(Clone, Copy, Deserialize, Serialize)]
struct SavedRect { x: i32, y: i32, width: i32, height: i32 }

impl SavedRect {
    fn from_rect(rect: RECT) -> Self {
        Self { x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top }
    }
}

#[derive(Clone, Copy, PartialEq)]
enum GestureKind { Move, Resize }

struct Gesture { kind: GestureKind, start: RECT, scale: f64, monitor: MonitorInfoEx }

#[derive(Default)]
pub struct MediaGeometry { gesture: Mutex<Option<Gesture>> }

fn media_hwnd(app: &AppHandle) -> AeroResult<HWND> {
    let window = app.get_webview_window("media").ok_or_else(|| AeroError::other("media window missing"))?;
    Ok(HWND(window.hwnd()?.0))
}

fn current_rect(hwnd: HWND) -> AeroResult<RECT> {
    let mut rect = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut rect)?; }
    Ok(rect)
}

fn placement_file(app: &AppHandle) -> AeroResult<std::path::PathBuf> {
    Ok(crate::core::paths::config_dir(app)?.join("media-window.json"))
}

fn apply_rect(hwnd: HWND, rect: SavedRect) -> AeroResult<()> {
    unsafe { SetWindowPos(hwnd, None, rect.x, rect.y, rect.width, rect.height, SWP_NOACTIVATE | SWP_NOZORDER)?; }
    Ok(())
}

fn monitor_for_rect<'a>(monitors: &'a [MonitorInfoEx], rect: RECT) -> Option<&'a MonitorInfoEx> {
    let cx = rect.left + (rect.right - rect.left) / 2;
    let cy = rect.top + (rect.bottom - rect.top) / 2;
    monitors.iter().find(|m| cx >= m.bounds.x && cx < m.bounds.x + m.bounds.width
        && cy >= m.bounds.y && cy < m.bounds.y + m.bounds.height)
}

fn keep_on_monitor(mut rect: SavedRect, bounds: Rect, min_w: i32, min_h: i32) -> SavedRect {
    rect.width = rect.width.clamp(min_w.min(bounds.width), bounds.width);
    rect.height = rect.height.clamp(min_h.min(bounds.height), bounds.height);
    rect.x = rect.x.clamp(bounds.x, bounds.x + bounds.width - rect.width);
    rect.y = rect.y.clamp(bounds.y, bounds.y + bounds.height - rect.height);
    rect
}

pub fn position_media(app: &AppHandle) -> AeroResult<()> {
    let hwnd = media_hwnd(app)?;
    let monitors = enumerate_monitors()?;
    let settings = app.state::<SettingsStore>().get();
    let default_monitor = pick_monitor(&monitors, settings.dock.monitor.as_deref());
    let saved = placement_file(app).ok().and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice::<SavedRect>(&b).ok())
        .filter(|r| r.width > 0 && r.height > 0);
    let monitor = saved.and_then(|r| monitor_for_rect(&monitors, RECT {
        left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height,
    })).unwrap_or(default_monitor);
    let dock = app.get_webview_window("dock").and_then(|w| w.hwnd().ok())
        .map(|h| HWND(h.0));
    let dock_rect = dock.and_then(|h| current_rect(h).ok());
    // GetDpiForMonitor can report the pre-show system scale here. The dock is
    // already visible on the target display, so its window DPI is authoritative
    // for the first media rectangle, before the media WebView is shown.
    let scale = dock.zip(dock_rect)
        .filter(|(_, rect)| monitor_for_rect(&monitors, *rect)
            .is_some_and(|dock_monitor| dock_monitor.name == monitor.name))
        .map(|(h, _)| unsafe { GetDpiForWindow(h) } as f64 / 96.0)
        .unwrap_or(monitor.scale);
    let default_width = (800.0 * scale).round() as i32;
    let default_height = (270.0 * scale).round() as i32;
    let initial = if let Some(rect) = saved { rect } else {
        // Center the card in the area above the bottom dock. The dock's native
        // window includes a large transparent overlay region, so its top edge
        // is not the visual top of the dock shelf.
        let x = dock_rect.map(|r| (r.left + r.right - default_width) / 2)
            .unwrap_or(monitor.bounds.x + (monitor.bounds.width - default_width) / 2);
        let y = monitor.bounds.y + (monitor.bounds.height - default_height) / 2;
        SavedRect { x, y, width: default_width, height: default_height }
    };
    let rect = keep_on_monitor(initial, monitor.bounds,
        (520.0 * scale).round() as i32, (250.0 * scale).round() as i32);
    apply_rect(hwnd, rect)?;
    // A window created on another DPI can acquire a different scale once it
    // reaches this monitor. It is hidden here, so correct the physical minimum
    // before the first paint rather than letting the card start cropped.
    let actual_scale = unsafe { GetDpiForWindow(hwnd) } as f64 / 96.0;
    if actual_scale > scale + 0.01 {
        let corrected = if saved.is_some() { rect } else {
            let width = (800.0 * actual_scale).round() as i32;
            let height = (270.0 * actual_scale).round() as i32;
            SavedRect {
                x: rect.x + (rect.width - width) / 2,
                y: rect.y + (rect.height - height) / 2,
                width, height,
            }
        };
        let corrected = keep_on_monitor(corrected, monitor.bounds,
            (520.0 * actual_scale).round() as i32,
            (250.0 * actual_scale).round() as i32);
        apply_rect(hwnd, corrected)?;
    }
    Ok(())
}

#[tauri::command]
pub fn begin_media_gesture(app: AppHandle, kind: String) -> AeroResult<()> {
    let kind = match kind.as_str() {
        "move" => GestureKind::Move,
        "resize" => GestureKind::Resize,
        _ => return Err(AeroError::other("invalid media gesture")),
    };
    let geometry = app.state::<MediaGeometry>();
    let mut active = geometry.gesture.lock();
    if active.is_some() { return Err(AeroError::other("media gesture already active")); }
    let hwnd = media_hwnd(&app)?;
    let start = current_rect(hwnd)?;
    let monitors = enumerate_monitors()?;
    let monitor = monitor_for_rect(&monitors, start).unwrap_or(pick_monitor(&monitors, None)).clone();
    *active = Some(Gesture { kind, start, scale: unsafe { GetDpiForWindow(hwnd) } as f64 / 96.0, monitor });
    Ok(())
}

#[tauri::command]
pub fn update_media_gesture(app: AppHandle, dx: f64, dy: f64) -> AeroResult<()> {
    if !dx.is_finite() || !dy.is_finite() { return Err(AeroError::other("invalid media gesture delta")); }
    let geometry = app.state::<MediaGeometry>();
    let active = geometry.gesture.lock();
    let Some(g) = active.as_ref() else { return Ok(()); };
    let dx = (dx * g.scale).round() as i32;
    let dy = (dy * g.scale).round() as i32;
    let initial = SavedRect::from_rect(g.start);
    let rect = match g.kind {
        GestureKind::Move => SavedRect { x: initial.x + dx, y: initial.y + dy, ..initial },
        GestureKind::Resize => SavedRect { width: initial.width + dx, height: initial.height + dy, ..initial },
    };
    let bounds = g.monitor.bounds;
    let min_w = (520.0 * g.scale).round() as i32;
    let min_h = (250.0 * g.scale).round() as i32;
    let rect = if g.kind == GestureKind::Resize {
        let max_w = (bounds.x + bounds.width - initial.x).max(min_w.min(bounds.width));
        let max_h = (bounds.y + bounds.height - initial.y).max(min_h.min(bounds.height));
        SavedRect { width: rect.width.clamp(min_w.min(max_w), max_w),
            height: rect.height.clamp(min_h.min(max_h), max_h), ..initial }
    } else { keep_on_monitor(rect, bounds, min_w, min_h) };
    apply_rect(media_hwnd(&app)?, rect)
}

#[tauri::command]
pub fn finish_media_gesture(app: AppHandle, cancel: bool) -> AeroResult<()> {
    let geometry = app.state::<MediaGeometry>();
    let active = geometry.gesture.lock().take();
    let Some(g) = active else { return Ok(()); };
    let hwnd = media_hwnd(&app)?;
    if cancel { return apply_rect(hwnd, SavedRect::from_rect(g.start)); }
    let rect = SavedRect::from_rect(current_rect(hwnd)?);
    let path = placement_file(&app)?;
    if let Some(parent) = path.parent() { std::fs::create_dir_all(parent)?; }
    std::fs::write(path, serde_json::to_vec_pretty(&rect)?)?;
    Ok(())
}
