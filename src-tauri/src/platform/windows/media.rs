//! The Windows global media session selected by the system. Applications
//! which do not publish SystemMediaTransportControls have no session here.

use base64::Engine;
use serde::Serialize;
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSessionManager as Manager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
};
use windows::Storage::Streams::DataReader;
use windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};

use crate::core::{AeroError, AeroResult};

// WinRT async completions need a Windows Runtime MTA on this blocking worker.
// The regular COM helper initializes an STA for Shell/WASAPI and can leave a
// RequestAsync().join() waiting forever without a message pump.
struct WinRtApartment;
impl WinRtApartment {
    fn new() -> windows::core::Result<Self> {
        unsafe { RoInitialize(RO_INIT_MULTITHREADED)?; }
        Ok(Self)
    }
}
impl Drop for WinRtApartment {
    fn drop(&mut self) { unsafe { RoUninitialize(); } }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub available: bool,
    pub title: String,
    pub artist: String,
    pub artwork_url: Option<String>,
    pub playing: bool,
}

fn artwork(props: &windows::Media::Control::GlobalSystemMediaTransportControlsSessionMediaProperties) -> Option<String> {
    let reference = props.Thumbnail().ok()?;
    let stream = reference.OpenReadAsync().ok()?.join().ok()?;
    // Never ship an unbounded album image through WebView IPC.
    let size = stream.Size().ok()?;
    if size == 0 || size > 512 * 1024 { return None; }
    let reader = DataReader::CreateDataReader(&stream).ok()?;
    let count = reader.LoadAsync(size as u32).ok()?.join().ok()?;
    let mut data = vec![0u8; count as usize];
    reader.ReadBytes(&mut data).ok()?;
    let mime = if data.starts_with(b"\x89PNG") { "image/png" }
        else if data.starts_with(b"RIFF") && data.get(8..12) == Some(b"WEBP") { "image/webp" }
        else { "image/jpeg" };
    Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(data)))
}

pub fn read_media() -> MediaInfo {
    let Ok(_winrt) = WinRtApartment::new() else { return MediaInfo::default(); };
    let Some(session) = Manager::RequestAsync().ok().and_then(|op| op.join().ok())
        .and_then(|manager| manager.GetCurrentSession().ok()) else {
        return MediaInfo::default();
    };
    let Some(props) = session.TryGetMediaPropertiesAsync().ok().and_then(|op| op.join().ok()) else {
        return MediaInfo::default();
    };
    MediaInfo {
        available: true,
        title: props.Title().map(|s| s.to_string()).unwrap_or_default(),
        artist: props.Artist().map(|s| s.to_string()).unwrap_or_default(),
        artwork_url: artwork(&props),
        playing: session.GetPlaybackInfo().ok()
            .and_then(|info| info.PlaybackStatus().ok()) == Some(PlaybackStatus::Playing),
    }
}

#[derive(Debug, Clone, Copy)]
pub enum MediaAction { Previous, Toggle, Next }

pub fn control(action: MediaAction) -> AeroResult<bool> {
    let _winrt = WinRtApartment::new()?;
    let manager = Manager::RequestAsync()?.join()?;
    let session = manager.GetCurrentSession()
        .map_err(|_| AeroError::other("no active Windows media session"))?;
    Ok(match action {
        MediaAction::Previous => session.TrySkipPreviousAsync()?.join()?,
        MediaAction::Toggle => session.TryTogglePlayPauseAsync()?.join()?,
        MediaAction::Next => session.TrySkipNextAsync()?.join()?,
    })
}
