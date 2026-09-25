import { useEffect, useRef, type PointerEvent } from "react";
import { flushSync } from "react-dom";

const SETTLE = "transform 140ms cubic-bezier(.2,.8,.2,1)";
type Options = {
  vertical: boolean;
  disabled: boolean;
  instant: boolean;
  onStart: () => void;
  onOrder: (ids: string[]) => void;
  onFinish: (ids: string[] | null) => void;
};
type Gesture = {
  nodes: HTMLElement[];
  ids: string[];
  index: number;
  slot: number;
  start: number;
  origin: number;
  delta: number;
  step: number;
  vertical: boolean;
  pointer: number;
  capture: HTMLElement;
  active: boolean;
};

/** Keep layout fixed during a drag. Only compositor translations follow input;
 * changing the DOM order mid-gesture makes layout projection fight the pointer. */
export function usePinnedReorder(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const ref = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const frame = useRef(0);
  const settling = useRef(0);
  const blockClick = useRef(false);

  function translate(node: HTMLElement, amount: number, vertical: boolean) {
    node.style.transform = vertical ? `translate3d(0,${amount}px,0)` : `translate3d(${amount}px,0,0)`;
  }

  function paint() {
    frame.current = 0;
    const g = gesture.current;
    if (!g?.active) return;
    const slot = Math.max(0, Math.min(g.ids.length - 1, Math.round(g.index + g.delta / g.step)));
    g.slot = slot;
    g.nodes.forEach((node, i) => {
      const shift = i === g.index ? g.delta
        : g.index < slot && i > g.index && i <= slot ? -g.step
        : g.index > slot && i >= slot && i < g.index ? g.step : 0;
      translate(node, shift, g.vertical);
    });
  }

  function finish(cancel: boolean) {
    const g = gesture.current;
    if (!g) return;
    cancelAnimationFrame(frame.current);
    paint();
    gesture.current = null;
    if (g.capture.hasPointerCapture(g.pointer)) g.capture.releasePointerCapture(g.pointer);
    if (!g.active) {
      g.nodes.forEach((node) => {
        node.style.transition = latest.current.instant ? "none" : SETTLE;
        translate(node, 0, g.vertical);
        node.style.removeProperty("z-index");
        node.style.removeProperty("will-change");
      });
      return;
    }
    const ids = [...g.ids];
    if (!cancel) ids.splice(g.slot, 0, ...ids.splice(g.index, 1));
    // Preserve each visible position across the single DOM reorder on release.
    const before = g.nodes.map((node) => node.getBoundingClientRect());
    flushSync(() => latest.current.onOrder(ids));
    g.nodes.forEach((node) => { node.style.transition = "none"; node.style.transform = "none"; });
    g.nodes.forEach((node, i) => {
      const after = node.getBoundingClientRect();
      translate(node, g.vertical ? before[i].top - after.top : before[i].left - after.left, g.vertical);
    });
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      g.nodes.forEach((node) => { node.style.transition = latest.current.instant ? "none" : SETTLE; translate(node, 0, g.vertical); });
      settling.current = window.setTimeout(() => {
        if (gesture.current) return;
        g.nodes.forEach((node) => {
          node.style.removeProperty("transform"); node.style.removeProperty("transition");
          node.style.removeProperty("z-index"); node.style.removeProperty("will-change");
        });
      }, 160);
    });
    latest.current.onFinish(cancel ? null : ids);
    // Keep cancellation and delayed pointerup clicks suppressed until a fresh press.
  }

  useEffect(() => {
    const cancel = () => finish(true);
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") cancel(); };
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", key);
      cancelAnimationFrame(frame.current);
      frame.current = 0;
      clearTimeout(settling.current);
    };
  }, []);

  return {
    ref,
    onPointerDown(e: PointerEvent<HTMLDivElement>) {
      if (e.button !== 0 || latest.current.disabled || gesture.current) return;
      blockClick.current = false;
      const item = (e.target as Element).closest<HTMLElement>("[data-reorder-id]");
      if (!item || !ref.current) return;
      const nodes = [...ref.current.querySelectorAll<HTMLElement>("[data-reorder-id]")];
      if (nodes.length < 2) return;
      cancelAnimationFrame(frame.current);
      frame.current = 0;
      clearTimeout(settling.current);
      const vertical = latest.current.vertical;
      const index = nodes.indexOf(item);
      const step = vertical ? nodes[1].offsetTop - nodes[0].offsetTop : nodes[1].offsetLeft - nodes[0].offsetLeft;
      if (step <= 0) return;
      const transform = new DOMMatrixReadOnly(getComputedStyle(item).transform);
      const offset = vertical ? transform.m42 : transform.m41;
      item.style.transition = "none";
      translate(item, offset, vertical);
      // Capture on the button so ordinary clicks keep their original target.
      const capture = (e.target as Element).closest<HTMLElement>("button") ?? item;
      capture.setPointerCapture(e.pointerId);
      gesture.current = { nodes, ids: nodes.map((node) => node.dataset.reorderId!), index, slot: index,
        start: (vertical ? e.clientY : e.clientX) - offset, origin: vertical ? e.clientY : e.clientX,
        delta: offset, step, vertical,
        pointer: e.pointerId, capture, active: false };
    },
    onPointerMove(e: PointerEvent<HTMLDivElement>) {
      const g = gesture.current;
      if (!g || e.pointerId !== g.pointer) return;
      const delta = (g.vertical ? e.clientY : e.clientX) - g.start;
      if (!g.active && Math.abs((g.vertical ? e.clientY : e.clientX) - g.origin) < 5) return;
      if (!g.active) {
        g.active = true;
        blockClick.current = true;
        g.nodes.forEach((node, i) => {
          node.style.transition = i === g.index || latest.current.instant ? "none" : SETTLE;
          node.style.willChange = "transform";
          node.style.zIndex = i === g.index ? "1002" : "3";
        });
        latest.current.onStart();
      }
      e.preventDefault();
      g.delta = Math.max(-g.index * g.step, Math.min((g.ids.length - 1 - g.index) * g.step, delta));
      if (!frame.current) frame.current = requestAnimationFrame(paint);
    },
    onPointerUp(e: PointerEvent<HTMLDivElement>) {
      const g = gesture.current;
      if (!g || e.pointerId !== g.pointer) return;
      if (g.active) g.delta = Math.max(-g.index * g.step, Math.min((g.ids.length - 1 - g.index) * g.step,
        (g.vertical ? e.clientY : e.clientX) - g.start));
      finish(false);
    },
    onPointerCancel() { finish(true); },
    onLostPointerCapture() { if (gesture.current) finish(true); },
    onClickCapture(e: React.MouseEvent<HTMLDivElement>) {
      if (blockClick.current) { e.preventDefault(); e.stopPropagation(); }
    },
  };
}
