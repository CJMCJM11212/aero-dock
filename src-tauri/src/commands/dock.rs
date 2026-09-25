//! Dock window geometry. The frontend measures its content (which changes
//! with icon count, size, and magnification headroom) and asks Rust to fit
//! the OS window; Rust owns edge/monitor math so the window always lands
//! inside the target monitor's work area.

use parking_lot::Mutex;
use tauri::{AppHandle, Manager};
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Gdi::{CreateRectRgn, SetWindowRgn, DeleteObject, HGDIOBJ};
use windows::Win32::UI::WindowsAndMessaging::{GetWindowRect, SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER, SWP_NOMOVE};
use windows::Win32::UI::HiDpi::GetDpiForWindow;

use crate::core::settings::{DockEdge, DockPosition, Settings, SettingsStore};
use crate::core::{AeroError, AeroResult};
use crate::platform::windows::monitors::{enumerate_monitors, pick_monitor, MonitorInfoEx, Rect};

/// Last content size requested by the frontend, in logical pixels.
pub struct DockGeometry {
    content_size: Mutex<(f64, f64)>,
    resize: Mutex<Option<ResizeSession>>,
    clip: Mutex<Option<ClipBand>>,
}

struct ClipBand {
    size: f64,
    open: bool,
    edge: DockEdge,
    applied: Option<(i32, i32, i32, i32)>,
}

/// Keep the WebView canvas fixed. Only expose the shelf band to drawing/input
/// while overlays are closed, so transparent reserved space is click-through.
#[tauri::command]
pub fn set_dock_band(app: AppHandle, size: f64, open: bool) -> AeroResult<()> {
    if !size.is_finite() || size < 1.0 { return Err(AeroError::other("invalid dock band")); }
    let edge = app.state::<SettingsStore>().get().dock.edge;
    *app.state::<DockGeometry>().clip.lock() = Some(ClipBand { size, open, edge, applied: None });
    apply_dock_clip(&app)
}

fn apply_dock_clip(app: &AppHandle) -> AeroResult<()> {
    let geometry = app.state::<DockGeometry>();
    let mut clip = geometry.clip.lock();
    let Some(clip) = clip.as_mut() else { return Ok(()); };
    let window = app.get_webview_window("dock").ok_or_else(|| AeroError::other("dock window missing"))?;
    let hwnd = HWND(window.hwnd()?.0);
    let mut rect = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut rect)?; }
    let w = rect.right - rect.left;
    let h = rect.bottom - rect.top;
    let band = (clip.size * unsafe { GetDpiForWindow(hwnd) } as f64 / 96.0).ceil() as i32;
    let bounds = if clip.open { (0, 0, w, h) } else {
        match clip.edge {
            DockEdge::Bottom => (0, (h - band).max(0), w, h),
            DockEdge::Top => (0, 0, w, band.min(h)),
            DockEdge::Left => (0, 0, band.min(w), h),
            DockEdge::Right => ((w - band).max(0), 0, w, h),
        }
    };
    if clip.applied == Some(bounds) { return Ok(()); }
    unsafe {
        let region = CreateRectRgn(bounds.0, bounds.1, bounds.2, bounds.3);
        if region.0.is_null() { return Err(AeroError::other("could not create dock region")); }
        if SetWindowRgn(hwnd, Some(region), true) == 0 {
            let _ = DeleteObject(HGDIOBJ(region.0));
            return Err(AeroError::other("could not apply dock region"));
        }
        // Windows owns the region after successful SetWindowRgn.
    }
    clip.applied = Some(bounds);
    Ok(())
}

struct ResizeSession {
    start: RECT,
    content: (f64, f64),
    scale: f64,
    monitor: MonitorInfoEx,
    slots: f64,
    vertical: bool,
    initial: f64,
    current: f64,
}

impl Default for DockGeometry {
    fn default() -> Self {
        Self {
            // sensible pre-first-measure footprint
            content_size: Mutex::new((720.0, 160.0)),
            resize: Mutex::new(None),
            clip: Mutex::new(None),
        }
    }
}

/// Frontend reports its content size; window is resized and repositioned.
#[tauri::command]
pub fn resize_dock(app: AppHandle, width: f64, height: f64, anchor_start: Option<bool>) -> AeroResult<()> {
    let geometry = app.state::<DockGeometry>();
    if geometry.resize.lock().is_some() { return Ok(()); }
    let previous = {
        let mut content = geometry.content_size.lock();
        let next = (width.max(1.0), height.max(1.0));
        if (content.0 - next.0).abs() < 0.001 && (content.1 - next.1).abs() < 0.001 {
            return Ok(());
        }
        let previous = *content;
        *content = next;
        previous
    };
    if anchor_start == Some(true) {
        let settings = app.state::<SettingsStore>().get();
        let window = app.get_webview_window("dock").ok_or_else(|| AeroError::other("dock window missing"))?;
        let hwnd = HWND(window.hwnd()?.0);
        let mut rect = RECT::default();
        unsafe { GetWindowRect(hwnd, &mut rect)?; }
        let scale = unsafe { GetDpiForWindow(hwnd) } as f64 / 96.0;
        let w = (width * scale).round().max(1.0) as i32;
        let h = (height * scale).round().max(1.0) as i32;
        let x = if settings.dock.edge == DockEdge::Right { rect.right - w } else { rect.left };
        let y = if settings.dock.edge == DockEdge::Bottom { rect.bottom - h } else { rect.top };
        unsafe { SetWindowPos(hwnd, None, x, y, w, h, SWP_NOACTIVATE | SWP_NOZORDER)?; }
        apply_dock_clip(&app)?;
        let vertical = matches!(settings.dock.edge, DockEdge::Left | DockEdge::Right);
        if if vertical { previous.1 != height } else { previous.0 != width } {
            capture_dock_position(&app)?;
        }
        return Ok(());
    }
    position_dock(&app)
}

/// Recompute and apply the dock window's position from current settings.
/// Called on resize requests, settings changes, and WM_DISPLAYCHANGE.
pub fn position_dock(app: &AppHandle) -> AeroResult<()> {
    let settings = app.state::<SettingsStore>().get();
    let geometry = app.state::<DockGeometry>();
    if geometry.resize.lock().is_some() { return Ok(()); }
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
        let hwnd = HWND(hwnd.0);
        let mut current = RECT::default();
        GetWindowRect(hwnd, &mut current)?;
        let w = w.max(1);
        let h = h.max(1);
        if current.left != x || current.top != y
            || current.right - current.left != w || current.bottom - current.top != h {
            SetWindowPos(hwnd, None, x, y, w, h, SWP_NOACTIVATE | SWP_NOZORDER)?;
        }
    }
    apply_dock_clip(app)
}

/// Begin without moving or enlarging the window. The gesture owns geometry
/// until commit/cancel, so settings events cannot recenter it halfway through.
#[tauri::command]
pub fn begin_dock_resize(app: AppHandle, slots: u32, vertical: bool) -> AeroResult<()> {
    let geometry = app.state::<DockGeometry>();
    let mut active = geometry.resize.lock();
    if active.is_some() { return Err(AeroError::other("dock resize already active")); }
    let window = app.get_webview_window("dock").ok_or_else(|| AeroError::other("dock window missing"))?;
    let hwnd = HWND(window.hwnd()?.0);
    let mut rect = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut rect)?; }
    let scale = unsafe { GetDpiForWindow(hwnd) } as f64 / 96.0;
    let settings = app.state::<SettingsStore>().get();
    let monitors = enumerate_monitors()?;
    let monitor = pick_monitor(&monitors, settings.dock.monitor.as_deref()).clone();
    *active = Some(ResizeSession {
        start: rect, content: *geometry.content_size.lock(), scale, monitor,
        slots: slots.clamp(1, 1000) as f64, vertical,
        initial: settings.dock.icon_size as f64, current: settings.dock.icon_size as f64,
    });
    Ok(())
}

fn apply_resize(hwnd: HWND, session: &mut ResizeSession, size: f64) -> AeroResult<f64> {
    if !size.is_finite() { return Err(AeroError::other("invalid dock size")); }
    let size = size.clamp(32.0, 128.0);
    if size == session.current { return Ok(size); }
    let delta = ((size - session.initial) * session.slots * session.scale).round() as i32;
    let width = session.start.right - session.start.left + if session.vertical { 0 } else { delta };
    let height = session.start.bottom - session.start.top + if session.vertical { delta } else { 0 };
    // Never move the origin, recenter, or change the perpendicular dimension.
    unsafe { SetWindowPos(hwnd, None, 0, 0, width.max(1), height.max(1),
        SWP_NOMOVE | SWP_NOACTIVATE | SWP_NOZORDER)?; }
    session.current = size;
    Ok(size)
}

#[tauri::command]
pub fn update_dock_resize(app: AppHandle, size: f64) -> AeroResult<f64> {
    let geometry = app.state::<DockGeometry>();
    let mut active = geometry.resize.lock();
    let session = active.as_mut().ok_or_else(|| AeroError::other("no dock resize active"))?;
    let window = app.get_webview_window("dock").ok_or_else(|| AeroError::other("dock window missing"))?;
    let size = apply_resize(HWND(window.hwnd()?.0), session, size)?;
    apply_dock_clip(&app)?;
    Ok(size)
}

#[tauri::command]
pub fn finish_dock_resize(app: AppHandle, cancel: bool) -> AeroResult<Settings> {
    let geometry = app.state::<DockGeometry>();
    let mut active = geometry.resize.lock();
    let Some(session) = active.as_mut() else { return Ok(app.state::<SettingsStore>().get()); };
    let window = app.get_webview_window("dock").ok_or_else(|| AeroError::other("dock window missing"))?;
    let hwnd = HWND(window.hwnd()?.0);
    if cancel {
        unsafe { SetWindowPos(hwnd, None, session.start.left, session.start.top,
            session.start.right - session.start.left, session.start.bottom - session.start.top,
            SWP_NOACTIVATE | SWP_NOZORDER)?; }
        *geometry.content_size.lock() = session.content;
        *active = None;
        apply_dock_clip(&app)?;
        return Ok(app.state::<SettingsStore>().get());
    }
    let final_size = session.current.round() as u32;
    apply_resize(hwnd, session, final_size as f64)?;
    apply_dock_clip(&app)?;
    let mut rect = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut rect)?; }
    let delta = (final_size as f64 - session.initial) * session.slots;
    *geometry.content_size.lock() = (
        session.content.0 + if session.vertical { 0.0 } else { delta },
        session.content.1 + if session.vertical { delta } else { 0.0 },
    );
    let position = DockPosition {
        center_x: (((rect.left as f64 + rect.right as f64) / 2.0 - session.monitor.bounds.x as f64)
            / session.monitor.scale).round() as i32,
        bottom_y: ((rect.bottom as f64 - session.monitor.bounds.y as f64)
            / session.monitor.scale).round() as i32,
    };
    let result = app.state::<SettingsStore>().update(&app, |settings| {
        settings.dock.icon_size = final_size;
        settings.dock.position = Some(position);
    });
    *active = None;
    result
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
    // Use the same native rect that the ZEUSLAP guard observes. Tauri's
    // outer_size includes an extra invisible frame on this WebView2 window,
    // which shifted a saved bottom anchor by about 75 physical pixels.
    let hwnd = window.hwnd()?;
    let mut rect = RECT::default();
    unsafe { GetWindowRect(HWND(hwnd.0), &mut rect)?; }
    let position = DockPosition {
        center_x: (((rect.left as f64 + rect.right as f64) / 2.0 - monitor.bounds.x as f64) / monitor.scale).round() as i32,
        bottom_y: ((rect.bottom as f64 - monitor.bounds.y as f64) / monitor.scale).round() as i32,
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
