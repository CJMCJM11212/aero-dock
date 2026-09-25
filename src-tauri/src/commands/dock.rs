//! Dock window geometry. The frontend measures its content (which changes
//! with icon count, size, and magnification headroom) and asks Rust to fit
//! the OS window; Rust owns edge/monitor math so the window always lands
//! inside the target monitor's work area.

use parking_lot::Mutex;
use tauri::{AppHandle, Manager};
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER};

use crate::core::settings::{DockEdge, DockPosition, SettingsStore};
use crate::core::{AeroError, AeroResult};
use crate::platform::windows::monitors::{enumerate_monitors, pick_monitor, MonitorInfoEx, Rect};

/// Last content size requested by the frontend, in logical pixels.
pub struct DockGeometry {
    content_size: Mutex<(f64, f64)>,
}

impl Default for DockGeometry {
    fn default() -> Self {
        Self {
            // sensible pre-first-measure footprint
            content_size: Mutex::new((720.0, 160.0)),
        }
    }
}

/// Frontend reports its content size; window is resized and repositioned.
#[tauri::command]
pub fn resize_dock(app: AppHandle, width: f64, height: f64) -> AeroResult<()> {
    let geometry = app.state::<DockGeometry>();
    *geometry.content_size.lock() = (width.max(1.0), height.max(1.0));
    position_dock(&app)
}

/// Recompute and apply the dock window's position from current settings.
/// Called on resize requests, settings changes, and WM_DISPLAYCHANGE.
pub fn position_dock(app: &AppHandle) -> AeroResult<()> {
    let settings = app.state::<SettingsStore>().get();
    let geometry = app.state::<DockGeometry>();
    let (logical_w, logical_h) = *geometry.content_size.lock();

    let monitors = enumerate_monitors()?;
    let monitor = pick_monitor(&monitors, settings.dock.monitor.as_deref());

    let scale = monitor.scale;
    let margin = if settings.dock.floating {
        (settings.dock.floating_margin as f64 * scale).round() as i32
    } else {
        0
    };

    let w = (logical_w * scale).round() as i32;
    let h = (logical_h * scale).round() as i32;
    let area = if settings.dock.use_monitor_bounds { monitor.bounds } else { monitor.work_area };
    let (x, y) = if let Some(position) = settings.dock.position {
        place_custom(monitor, area, position, w, h)
    } else {
        place_on_edge(monitor, settings.dock.edge, w, h, margin,
            settings.dock.use_monitor_bounds)
    };

    let window = app
        .get_webview_window("dock")
        .ok_or_else(|| AeroError::other("dock window missing"))?;
    // Apply size and position in one native operation. Two Tauri calls let
    // WebView2 paint an intermediate frame at the old origin, which looked
    // like the dock jumping while the resize corner was dragged.
    let hwnd = window.hwnd()?;
    unsafe {
        SetWindowPos(HWND(hwnd.0), None, x, y, w.max(1), h.max(1),
            SWP_NOACTIVATE | SWP_NOZORDER)?;
    }
    Ok(())
}

/// Pure placement math: center the dock along the chosen work-area edge.
fn place_on_edge(
    monitor: &MonitorInfoEx,
    edge: DockEdge,
    w: i32,
    h: i32,
    margin: i32,
    use_monitor_bounds: bool,
) -> (i32, i32) {
    let wa = if use_monitor_bounds { monitor.bounds } else { monitor.work_area };
    match edge {
        DockEdge::Bottom => (wa.x + (wa.width - w) / 2, wa.y + wa.height - h - margin),
        DockEdge::Top => (wa.x + (wa.width - w) / 2, wa.y + margin),
        DockEdge::Left => (wa.x + margin, wa.y + (wa.height - h) / 2),
        DockEdge::Right => (wa.x + wa.width - w - margin, wa.y + (wa.height - h) / 2),
    }
}

/// Keep the user's chosen center and bottom edge stable as the dock changes size.
fn place_custom(monitor: &MonitorInfoEx, area: Rect, position: DockPosition, w: i32, h: i32) -> (i32, i32) {
    let x = monitor.bounds.x + (position.center_x as f64 * monitor.scale).round() as i32 - w / 2;
    let y = monitor.bounds.y + (position.bottom_y as f64 * monitor.scale).round() as i32 - h;
    let max_x = area.x + (area.width - w).max(0);
    let max_y = area.y + (area.height - h).max(0);
    (x.clamp(area.x, max_x), y.clamp(area.y, max_y))
}

/// Mark the current placement as user-controlled before Windows starts dragging.
/// The ZEUSLAP guard reads this persisted flag and stops correcting the Y position.
#[tauri::command]
pub fn begin_dock_move(app: AppHandle) -> AeroResult<()> {
    capture_dock_position(&app)?;
    Ok(())
}

/// The native drag loop can outlive startDragging's promise. Save only after
/// the primary mouse button has been released; the frontend retries otherwise.
#[tauri::command]
pub fn finish_dock_move(app: AppHandle) -> AeroResult<bool> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
    if (unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) } as u16 & 0x8000) != 0 {
        return Ok(false);
    }
    capture_dock_position(&app)?;
    position_dock(&app)?;
    Ok(true)
}

#[tauri::command]
pub fn nudge_dock(app: AppHandle, dx: i32, dy: i32) -> AeroResult<()> {
    capture_dock_position(&app)?;
    app.state::<SettingsStore>().update(&app, |s| {
        if let Some(position) = &mut s.dock.position {
            position.center_x = position.center_x.saturating_add(dx.clamp(-100, 100));
            position.bottom_y = position.bottom_y.saturating_add(dy.clamp(-100, 100));
        }
    })?;
    position_dock(&app)
}

#[tauri::command]
pub fn reset_dock_position(app: AppHandle) -> AeroResult<()> {
    app.state::<SettingsStore>().update(&app, |s| s.dock.position = None)?;
    position_dock(&app)
}

fn capture_dock_position(app: &AppHandle) -> AeroResult<DockPosition> {
    let settings = app.state::<SettingsStore>();
    let monitors = enumerate_monitors()?;
    let selected = settings.get().dock.monitor;
    let monitor = pick_monitor(&monitors, selected.as_deref());
    let window = app.get_webview_window("dock")
        .ok_or_else(|| AeroError::other("dock window missing"))?;
    let pos = window.outer_position()?;
    let size = window.outer_size()?;
    let position = DockPosition {
        center_x: ((pos.x as f64 + size.width as f64 / 2.0 - monitor.bounds.x as f64) / monitor.scale).round() as i32,
        bottom_y: ((pos.y as f64 + size.height as f64 - monitor.bounds.y as f64) / monitor.scale).round() as i32,
    };
    settings.update(app, |s| s.dock.position = Some(position))?;
    Ok(position)
}

/// List monitors so the settings UI can offer a monitor picker.
#[tauri::command]
pub fn list_monitors() -> AeroResult<Vec<MonitorInfoEx>> {
    enumerate_monitors()
}

/// Auto-hide the Windows taskbar (Aero Dock becomes the bar) or restore
/// it. Repositions the dock afterwards because the work area changes.
#[tauri::command]
pub async fn set_taskbar_hidden(app: AppHandle, hidden: bool) -> AeroResult<()> {
    crate::platform::windows::taskbar::set_taskbar_autohide(hidden);
    // the shell animates the taskbar away; re-measure once it settles
    tokio_sleep(600).await;
    position_dock(&app)
}

async fn tokio_sleep(ms: u64) {
    tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(std::time::Duration::from_millis(ms))
    })
    .await
    .ok();
}

/// Shut Aero Dock down for real, from anywhere in the UI.
///
/// The taskbar is restored here as well as in the exit handler. Quitting
/// is the one action where leaving the shell taskbar hidden would strand
/// someone with no way back, so it is worth doing twice.
#[tauri::command]
pub fn quit_app(app: AppHandle) {
    crate::platform::windows::taskbar::restore_taskbar();
    app.exit(0);
}

/// Let the dock take keyboard focus (search overlay) or give its
/// focus-immunity back when the overlay closes.
#[tauri::command]
pub fn set_dock_focusable(app: AppHandle, focusable: bool) -> AeroResult<()> {
    let window = app
        .get_webview_window("dock")
        .ok_or_else(|| AeroError::other("dock window missing"))?;
    let hwnd = window.hwnd()?;
    crate::platform::windows::dock_window::set_no_activate(
        windows::Win32::Foundation::HWND(hwnd.0),
        !focusable,
    )?;
    if focusable {
        window.set_focus()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::windows::monitors::Rect;

    fn monitor() -> MonitorInfoEx {
        MonitorInfoEx {
            name: r"\\.\DISPLAY1".into(),
            bounds: Rect { x: 0, y: 0, width: 2560, height: 1440 },
            work_area: Rect { x: 0, y: 0, width: 2560, height: 1392 }, // 48px taskbar
            scale: 1.25,
            is_primary: true,
        }
    }

    #[test]
    fn bottom_edge_sits_above_taskbar() {
        let (x, y) = place_on_edge(&monitor(), DockEdge::Bottom, 800, 200, 10, false);
        assert_eq!(x, (2560 - 800) / 2);
        assert_eq!(y, 1392 - 200 - 10);
    }

    #[test]
    fn left_edge_centers_vertically() {
        let (x, y) = place_on_edge(&monitor(), DockEdge::Left, 200, 800, 0, false);
        assert_eq!(x, 0);
        assert_eq!(y, (1392 - 800) / 2);
    }

    #[test]
    fn custom_position_keeps_its_center_and_bottom_and_stays_on_screen() {
        let monitor = monitor();
        let position = DockPosition { center_x: 1000, bottom_y: 1000 };
        let (x, y) = place_custom(&monitor, monitor.bounds, position, 800, 200);
        assert_eq!((x, y), (850, 1050));
        let outside = DockPosition { center_x: 9000, bottom_y: 9000 };
        assert_eq!(place_custom(&monitor, monitor.bounds, outside, 800, 200), (1760, 1240));
    }
}

/// Trim or restore the calling window's memory. The dock calls this with
/// `true` when it goes to sleep after a spell with no interaction, and
/// with `false` the moment the cursor comes back.
///
/// Best effort by design: an old WebView2 runtime without the API just
/// keeps its caches, which is what it did before this existed.
#[tauri::command]
pub fn set_memory_saver(webview: tauri::Webview, low: bool) {
    #[cfg(windows)]
    {
        let result = webview.with_webview(move |platform| {
            if let Err(e) =
                crate::platform::windows::memory::set_memory_target(&platform.controller(), low)
            {
                log::debug!("memory target not applied: {e}");
            }
        });
        if let Err(e) = result {
            log::debug!("could not reach the webview: {e}");
        }
    }
    #[cfg(not(windows))]
    let _ = (webview, low);
}
