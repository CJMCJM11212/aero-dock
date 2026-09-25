import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ipc } from "../../ipc/commands";
import type { MediaStatus } from "../../ipc/types";
import { MediaPlayer } from "./MediaPlayer";

type Gesture = {
  pointerId: number;
  startX: number;
  startY: number;
  dx: number;
  dy: number;
  sequence: number;
  sent: number;
  started: boolean;
  finishing: boolean;
  failed: boolean;
  begin: Promise<void>;
  sending: Promise<void> | null;
};

const emptyStatus: MediaStatus = {
  media: { available: false, title: "", artist: "", artworkUrl: null, playing: false },
  volume: { available: false, level: 0, muted: false },
  microphone: { available: false, muted: false },
};

export function MediaWindow() {
  const [status, setStatus] = useState<MediaStatus>(emptyStatus);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState("");
  const gesture = useRef<Gesture | null>(null);
  const volumeQueue = useRef<{ desired: number | null; sending: boolean }>({ desired: null, sending: false });
  const polling = useRef(false);

  const reportError = useCallback((cause: unknown) => {
    console.error(cause);
    setError(String(cause));
  }, []);

  const refresh = useCallback(async () => {
    if (polling.current) return;
    polling.current = true;
    try {
      const next = await ipc.getMediaStatus();
      setStatus(next);
      if (!volumeQueue.current.sending && volumeQueue.current.desired === null) {
        setLevel(next.volume.level);
      }
    } catch (cause) {
      reportError(cause);
    } finally {
      polling.current = false;
    }
  }, [reportError]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2500);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const sendGestureUpdates = useCallback((current: Gesture) => {
    if (!current.started || current.failed || current.finishing || current.sending || current.sent === current.sequence) return;
    current.sending = (async () => {
      while (!current.finishing && current.sent !== current.sequence) {
        const { dx, dy, sequence } = current;
        await ipc.updateMediaGesture(dx, dy);
        current.sent = sequence;
      }
    })().catch((cause) => {
      current.failed = true;
      reportError(cause);
    }).finally(() => {
      current.sending = null;
      if (!current.failed && !current.finishing && current.sent !== current.sequence) sendGestureUpdates(current);
    });
  }, [reportError]);

  const startGesture = useCallback((kind: "move" | "resize", event: ReactPointerEvent) => {
    if (gesture.current || event.button !== 0 && event.pointerType === "mouse") return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const current: Gesture = {
      pointerId: event.pointerId, startX: event.screenX, startY: event.screenY,
      dx: 0, dy: 0, sequence: 0, sent: 0, started: false, finishing: false,
      failed: false, begin: Promise.resolve(), sending: null,
    };
    gesture.current = current;
    current.begin = ipc.beginMediaGesture(kind).then(() => {
      current.started = true;
      sendGestureUpdates(current);
    }).catch((cause) => {
      gesture.current = null;
      reportError(cause);
    });
  }, [reportError, sendGestureUpdates]);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const current = gesture.current;
      if (!current || event.pointerId !== current.pointerId || current.finishing) return;
      current.dx = event.screenX - current.startX;
      current.dy = event.screenY - current.startY;
      current.sequence++;
      sendGestureUpdates(current);
    };
    const end = (event: PointerEvent) => {
      const current = gesture.current;
      if (!current || event.pointerId !== current.pointerId || current.finishing) return;
      current.dx = event.screenX - current.startX;
      current.dy = event.screenY - current.startY;
      current.sequence++;
      current.finishing = true;
      gesture.current = null;
      void (async () => {
        await current.begin;
        if (!current.started) return;
        await current.sending;
        // A lost pointer capture should keep the last visible placement; a
        // reset to the starting rectangle looks like the card jumped away.
        const cancel = current.failed;
        try {
          if (!cancel && current.sent !== current.sequence) {
            await ipc.updateMediaGesture(current.dx, current.dy);
          }
          await ipc.finishMediaGesture(cancel);
        } catch (cause) {
          reportError(cause);
          await ipc.finishMediaGesture(true).catch(reportError);
        }
      })();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, [reportError, sendGestureUpdates]);

  const changeVolume = useCallback((next: number) => {
    setLevel(next);
    const queue = volumeQueue.current;
    queue.desired = next;
    if (queue.sending) return;
    queue.sending = true;
    void (async () => {
      try {
        while (queue.desired !== null) {
          const desired = queue.desired;
          queue.desired = null;
          await ipc.setVolume(desired);
        }
      } catch (cause) {
        reportError(cause);
      } finally {
        queue.sending = false;
      }
    })();
  }, [reportError]);

  const control = useCallback((action: "previous" | "toggle" | "next") => {
    void ipc.controlMedia(action).then(() => void refresh()).catch(reportError);
  }, [refresh, reportError]);

  return (
    <main style={{ width: "100%", height: "100%", padding: 7 }}>
      <MediaPlayer
        title={status.media.title}
        artist={status.media.artist}
        artworkUrl={status.media.artworkUrl}
        playing={status.media.playing}
        mediaAvailable={status.media.available}
        volume={level}
        speakerMuted={status.volume.muted}
        microphoneMuted={status.microphone.muted}
        microphoneAvailable={status.microphone.available}
        onPrevious={() => control("previous")}
        onTogglePlayback={() => control("toggle")}
        onNext={() => control("next")}
        onVolumeChange={changeVolume}
        onToggleSpeakerMute={() => {
          void ipc.setVolume(undefined, !status.volume.muted).then(refresh).catch(reportError);
        }}
        onToggleMicrophoneMute={() => {
          void ipc.setMicrophoneMute(!status.microphone.muted)
            .then((microphone) => setStatus((previous) => ({ ...previous, microphone })))
            .catch(reportError);
        }}
        onMovePointerDown={(event) => startGesture("move", event)}
        onResizePointerDown={(event) => startGesture("resize", event)}
      />
      {error && <div role="alert" onClick={() => setError("")}
        style={{ position: "absolute", left: 20, right: 20, bottom: 18, zIndex: 5,
          borderRadius: 12, padding: "7px 12px", color: "white", background: "#8a343c",
          fontSize: 12, cursor: "pointer" }}>{error}</div>}
    </main>
  );
}
