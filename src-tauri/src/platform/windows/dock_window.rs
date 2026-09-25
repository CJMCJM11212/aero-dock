//! Win32 styling for the dock window: keep it out of Alt-Tab and the
//! taskbar, and stop it from stealing focus from the app the user is
//! actually working in (docks are furniture, not windows).

use windows::core::BOOL;
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_APPWINDOW, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW,
};

use crate::core::AeroResult;

#[repr(C)]
struct AccentPolicy { state: i32, flags: i32, color: u32, animation: i32 }

#[repr(C)]
struct WindowCompositionAttributeData {
    attribute: i32,
    data: *mut std::ffi::c_void,
    size: usize,
}

// This compositor entry point is exported by user32.dll but not its import
// library, so resolve it at startup instead of linking against it.
#[link(name = "kernel32")]
extern "system" {
    fn GetModuleHandleW(name: *const u16) -> *mut std::ffi::c_void;
    fn GetProcAddress(module: *mut std::ffi::c_void, name: *const u8) -> *mut std::ffi::c_void;
}

/// WebView2's CSS backdrop-filter only sees its transparent canvas. Apply
/// Windows compositor blur to the media window so the actual desktop behind
/// the single rounded card is softened as well.
pub fn apply_media_blur(hwnd: HWND) -> AeroResult<()> {
    let dll: Vec<u16> = "user32.dll".encode_utf16().chain(std::iter::once(0)).collect();
    let function = unsafe {
        let module = GetModuleHandleW(dll.as_ptr());
        if module.is_null() { return Err(crate::core::AeroError::other("user32.dll unavailable")); }
        GetProcAddress(module, b"SetWindowCompositionAttribute\0".as_ptr())
    };
    if function.is_null() {
        return Err(crate::core::AeroError::other("media blur API unavailable"));
    }
    let set_window_composition_attribute: unsafe extern "system" fn(HWND, *mut WindowCompositionAttributeData) -> BOOL =
        unsafe { std::mem::transmute(function) };
    let mut policy = AccentPolicy { state: 3, flags: 0, color: 0, animation: 0 };
    let mut data = WindowCompositionAttributeData {
        attribute: 19,
        data: (&mut policy as *mut AccentPolicy).cast(),
        size: std::mem::size_of::<AccentPolicy>(),
    };
    if !unsafe { set_window_composition_attribute(hwnd, &mut data) }.as_bool() {
        return Err(crate::core::AeroError::other("could not enable media background blur"));
    }
    Ok(())
}

/// Apply dock chrome: WS_EX_TOOLWINDOW (no Alt-Tab entry), no
/// WS_EX_APPWINDOW (no taskbar button), WS_EX_NOACTIVATE (clicks don't
/// pull focus away from the foreground app).
pub fn apply_dock_styles(hwnd: HWND) -> AeroResult<()> {
    unsafe {
        let mut ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as isize;
        ex |= (WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0) as isize;
        ex &= !(WS_EX_APPWINDOW.0 as isize);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex);
    }
    Ok(())
}

/// Temporarily allow the dock to take keyboard focus (search overlay),
/// or give focus-immunity back when the overlay closes.
pub fn set_no_activate(hwnd: HWND, no_activate: bool) -> AeroResult<()> {
    unsafe {
        let mut ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as isize;
        if no_activate {
            ex |= WS_EX_NOACTIVATE.0 as isize;
        } else {
            ex &= !(WS_EX_NOACTIVATE.0 as isize);
        }
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex);
    }
    Ok(())
}
