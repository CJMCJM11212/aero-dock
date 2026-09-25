import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { ipc } from "../../ipc/commands";
import { useSettings } from "../../state/settingsStore";
import { notify } from "../feedback/toastStore";

type Gesture = {
  pointer: number | null;
  origin: number;
  initial: number;
  desired: number;
  painted: number;
  slots: number;
  ready: Promise<void>;
  pending: Promise<void> | null;
  frame: number | null;
  closing: boolean;
  detach: () => void;
};

/** One resize transaction: fixed window origin, coalesced updates, one save. */
export function useDockResize(iconSize: number, count: number, vertical: boolean, onBegin: () => void) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const active = useRef<Gesture | null>(null);
  const [resizing, setResizing] = useState(false);
  const paint = useCallback((size: number) => {
    viewportRef.current?.style.setProperty("--icon-size", `${size}px`);
  }, []);

  const close = useCallback(async (cancel: boolean) => {
    const gesture = active.current;
    if (!gesture || gesture.closing) return;
    gesture.closing = true;
    gesture.detach();
    if (gesture.frame !== null) cancelAnimationFrame(gesture.frame);
    try {
      await gesture.ready;
      await gesture.pending;
      if (!cancel) paint(await ipc.updateDockResize(Math.round(gesture.desired)));
      const settings = await ipc.finishDockResize(cancel);
      paint(settings.dock.iconSize);
      useSettings.setState({ settings });
    } catch (error) {
      try {
        const settings = await ipc.finishDockResize(true);
        paint(settings.dock.iconSize);
        useSettings.setState({ settings });
      } catch { paint(gesture.initial); }
      notify.error("Could not resize dock", error);
    } finally {
      if (active.current === gesture) active.current = null;
      setResizing(false);
    }
  }, [paint]);

  const queue = useCallback(function schedule() {
    const gesture = active.current;
    if (!gesture || gesture.closing || gesture.frame !== null || gesture.pending) return;
    gesture.frame = requestAnimationFrame(() => {
      gesture.frame = null;
      const desired = gesture.desired;
      gesture.pending = (async () => {
        await gesture.ready;
        // Shrink the content first, grow the window first: neither direction
        // exposes a clipped frame while WebView2 processes WM_SIZE.
        if (desired < gesture.painted) {
          paint(desired);
          gesture.painted = desired;
        }
        const applied = await ipc.updateDockResize(desired);
        if (active.current === gesture) {
          paint(applied);
          gesture.painted = applied;
        }
      })();
      void gesture.pending.then(() => {
        gesture.pending = null;
        if (gesture.desired !== desired) schedule();
      }, () => {
        gesture.pending = null;
        void close(true);
      });
    });
  }, [close, paint]);

  const begin = useCallback((pointer: number | null, origin: number) => {
    if (active.current) return null;
    onBegin();
    const slots = Math.max(count, 1);
    const gesture: Gesture = {
      pointer, origin, slots, initial: iconSize, desired: iconSize, painted: iconSize,
      ready: ipc.beginDockResize(slots, vertical), pending: null,
      frame: null, closing: false,
      detach: () => {},
    };
    active.current = gesture;
    setResizing(true);
    void gesture.ready.catch(() => close(true));
    return gesture;
  }, [close, count, iconSize, onBegin, vertical]);

  const startResize = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || active.current) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    const gesture = begin(event.pointerId, vertical ? event.screenY : event.screenX);
    if (!gesture) return;
    // WebView capture can be interrupted by native sizing. Listen across the
    // window for the lifetime of the gesture, including release off the grip.
    const move = (pointer: globalThis.PointerEvent) => {
      if (gesture.closing || pointer.pointerId !== gesture.pointer) return;
      const delta = (vertical ? pointer.screenY : pointer.screenX) - gesture.origin;
      gesture.desired = Math.max(32, Math.min(128, gesture.initial + delta / gesture.slots));
      queue();
    };
    const finish = (pointer: globalThis.PointerEvent) => {
      if (pointer.pointerId !== gesture.pointer) return;
      if (pointer.type === "pointerup") move(pointer);
      void close(pointer.type === "pointercancel");
    };
    const blur = () => { void close(true); };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", finish, true);
    window.addEventListener("pointercancel", finish, true);
    window.addEventListener("blur", blur);
    gesture.detach = () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", finish, true);
      window.removeEventListener("pointercancel", finish, true);
      window.removeEventListener("blur", blur);
    };
  }, [begin, close, queue, vertical]);

  const finishResize = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    if (active.current?.pointer !== event.pointerId || active.current.closing) return;
    // WebView2 can release capture after the native clipping region follows
    // a size update. The held button still owns this gesture; reclaim it.
    if (event.type === "lostpointercapture" && (event.buttons & 1) !== 0) {
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* window listeners remain active */ }
      return;
    }
    void close(event.type === "pointercancel" || event.type === "lostpointercapture");
  }, [close]);

  const resizeKey = useCallback((event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape" && active.current) {
      event.preventDefault();
      void close(true);
      return;
    }
    const direction = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[event.key];
    if (!direction || active.current) return;
    event.preventDefault();
    const gesture = begin(null, 0);
    if (gesture) {
      gesture.desired = Math.max(32, Math.min(128, iconSize + direction * 2));
      void close(false);
    }
  }, [begin, close, iconSize]);

  useEffect(() => () => {
    const gesture = active.current;
    if (gesture?.frame !== null && gesture?.frame !== undefined) cancelAnimationFrame(gesture.frame);
    if (gesture && !gesture.closing) void close(true);
  }, [close]);

  return { viewportRef, resizeRef: active, resizing, startResize, finishResize, resizeKey };
}
