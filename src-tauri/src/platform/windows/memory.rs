//! Asking WebView2 to give memory back while the dock is idle.
//!
//! Most of what the dock costs is not its own code. The Rust host is about
//! 10 MB and the page's JavaScript heap about 7 MB; the rest is Chromium,
//! and the largest single piece is the GPU process, which fills with raster
//! and tile caches that nothing ever tells it to drop. Measured on a real
//! desktop, signalling memory pressure took that process from about 125 MB
//! to about 61 MB and it stayed there.
//!
//! `MemoryUsageTargetLevel` is the supported way to send that signal. It is
//! meant for exactly this case: a WebView that goes inactive but still has
//! to run script, which rules out suspending it, because the clock and the
//! running-app list have to keep updating.

use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Controller, ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
};
use windows_core_061::Interface;

/// Set the target level for one WebView. `low` trims caches; `false`
/// restores normal behaviour for a smooth next interaction.
///
/// Runtimes older than the one that introduced ICoreWebView2_19 simply do
/// not support it; that returns an error rather than doing anything unsafe.
pub fn set_memory_target(controller: &ICoreWebView2Controller, low: bool) -> Result<(), String> {
    unsafe {
        let webview = controller.CoreWebView2().map_err(|e| e.to_string())?;
        let webview19: ICoreWebView2_19 = webview
            .cast()
            .map_err(|_| "this WebView2 runtime has no memory target API".to_string())?;
        let level = if low {
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
        } else {
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
        };
        webview19
            .SetMemoryUsageTargetLevel(level)
            .map_err(|e| e.to_string())
    }
}
