/**
 * A single dock icon: cursor-distance magnification and direct press feedback.
 */

import {
  motion,
  useSpring,
  useTransform,
  type MotionValue,
} from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { springs } from "../../engine/animation/springs";
import type { DockEdge } from "../../ipc/types";
import type { DockItemView } from "../../state/dockStore";
import { exeKey, useAppAudio } from "../../state/audioStore";
import { useMenu } from "./menuStore";

interface DockIconProps {
  item: DockItemView;
  /** Cursor position along the dock axis; Infinity = cursor away. */
  mouseAxis: MotionValue<number>;
  iconSize: number;
  magnify: boolean;
  magScale: number;
  vertical: boolean;
  edge: DockEdge;
  /** A reorder drag is in progress somewhere in the dock. */
  dragging: boolean;
  gamePaused: boolean;
  onLaunch: (item: DockItemView, target?: HTMLElement) => void;
  onContext: (item: DockItemView, target: HTMLElement) => void;
}

/** Speaker with the waves dropped when muted, drawn to match the glass
 *  controls rather than a font glyph. */
function Speaker({ muted }: { muted: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className="dock-volume-icon" aria-hidden>
      <path
        d="M3.4 6.2h2.2L8.4 3.6v8.8L5.6 9.8H3.4z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
      {muted ? (
        <path
          d="M10.6 6.2l3.2 3.6M13.8 6.2l-3.2 3.6"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          fill="none"
        />
      ) : (
        <>
          <path d="M10.5 5.9a3 3 0 0 1 0 4.2" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="round" />
          <path d="M12.4 4.3a5.6 5.6 0 0 1 0 7.4" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}

/** Tooltip entrance offset: the pill drifts in from the dock's edge.
 * Centering lives in CSS `translate` because motion owns `transform`. */
function labelFrom(edge: DockEdge): { x: number; y: number } {
  switch (edge) {
    case "bottom":
      return { x: 0, y: 6 };
    case "top":
      return { x: 0, y: -6 };
    case "left":
      return { x: -6, y: 0 };
    case "right":
      return { x: 6, y: 0 };
  }
}

export function DockIcon({
  item,
  mouseAxis,
  iconSize,
  magnify,
  magScale,
  vertical,
  edge,
  dragging,
  gamePaused,
  onLaunch,
  onContext,
}: DockIconProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const [solidIconSrc, setSolidIconSrc] = useState<string | null>(null);
  const classifyIcon = useCallback(() => {
    const img = imageRef.current;
    if (!img?.complete || !img.naturalWidth) return;
    // An opaque square already has its own background. Fill the rounded
    // tile with it instead of adding a second white frame around the image.
    try {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 8;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.drawImage(img, 0, 0, 8, 8);
      const pixels = context.getImageData(0, 0, 8, 8).data;
      const opaque = [0, 7, 56, 63].every((index) => pixels[index * 4 + 3] > 240);
      setSolidIconSrc(opaque ? item.iconSrc : null);
    } catch { setSolidIconSrc(null); }
  }, [item.iconSrc]);
  useLayoutEffect(classifyIcon, [classifyIcon]);
  const [hovered, setHovered] = useState(false);
  const [failedIconSrc, setFailedIconSrc] = useState<string | null>(null);
  // a flyout already names what you're pointing at, and the pill would
  // otherwise float over its bottom edge
  const flyoutOpen = useMenu((m) => m.item !== null);

  // per-app audio: scroll to change, middle-click to mute
  const audio = useAppAudio((a) => a.levels[exeKey(item.audioExe)]);
  const audioTick = useAppAudio((a) => a.tick);
  const nudgeVolume = useAppAudio((a) => a.nudge);
  const toggleMute = useAppAudio((a) => a.toggleMute);
  // `audioTick` is read so the indicator re-renders when its timer runs out
  void audioTick;
  const adjusting = useAppAudio.getState().isVisible(item.audioExe) && audio !== undefined;

  // distance from cursor to this icon's center along the dock axis
  const distance = useTransform(mouseAxis, (cursor) => {
    const el = ref.current;
    if (!el || !Number.isFinite(cursor)) return Infinity;
    const rect = el.getBoundingClientRect();
    const center = vertical ? rect.top + rect.height / 2 : rect.left + rect.width / 2;
    return cursor - center;
  });

  const reach = iconSize * 2.6;
  const peak = magnify ? magScale : 1;
  const targetScale = useTransform(distance, [-reach, 0, reach], [1, peak, 1]);
  const scale = useSpring(targetScale, springs.magnify);

  // When a drag starts, every icon springs back to its base size. Letting
  // that animate resizes tiles under the cursor mid-drag, which is a big
  // part of what felt like lag, so jump straight to the end value.
  useEffect(() => {
    if (dragging || gamePaused) scale.jump(1);
  }, [dragging, gamePaused, scale]);

  // The label can be wider than an end icon's available space. Keep its
  // actual rendered bounds inside the WebView instead of truncating names.
  useLayoutEffect(() => {
    if (!hovered || vertical) return;
    const label = labelRef.current;
    const icon = ref.current;
    if (!label || !icon) return;
    const bounds = icon.getBoundingClientRect();
    const labelWidth = label.offsetWidth;
    const left = bounds.left + bounds.width / 2 - labelWidth / 2;
    const shift = Math.max(12 - left, Math.min(0, window.innerWidth - 12 - left - labelWidth));
    label.style.setProperty("--label-shift", `${shift}px`);
  }, [hovered, item.name, vertical]);

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      onLaunch(item, e.currentTarget);
    },
    [item, onLaunch],
  );

  const initial = item.name.trim().charAt(0).toUpperCase() || "?";

  return (
    <motion.button
      ref={ref}
      className="dock-icon"
      data-dock-item={item.id}
      whileTap={gamePaused ? undefined : { scale: 0.96 }}
      transition={gamePaused ? { duration: 0 } : { type: "spring", stiffness: 800, damping: 42, mass: 0.25 }}
      onClick={handleClick}
      onContextMenu={(e) => {
        e.preventDefault();
        onContext(item, e.currentTarget);
      }}
      onWheel={(e) => {
        // one notch per detent, up scrolls louder
        const notches = -Math.sign(e.deltaY);
        if (notches === 0) return;
        void nudgeVolume(item.audioExe, notches);
      }}
      onMouseDown={(e) => {
        // stop the middle-button autoscroll cursor appearing
        if (e.button === 1) e.preventDefault();
      }}
      onAuxClick={(e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        void toggleMute(item.audioExe);
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label={item.name}
    >
      {adjusting && audio ? (
        <motion.span
          className="dock-label dock-volume-pill"
          data-edge={edge}
          initial={gamePaused ? false : { opacity: 0, scale: 0.98, ...labelFrom(edge) }}
          animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
          transition={gamePaused ? { duration: 0 } : { duration: 0.12, ease: "easeOut" }}
        >
          <Speaker muted={audio.muted} />
          <span className="dock-volume-value">
            {audio.muted ? "Muted" : `${audio.volume}%`}
          </span>
          <span className="dock-volume-track" aria-hidden>
            <span
              className="dock-volume-fill"
              style={{ width: `${audio.muted ? 0 : audio.volume}%` }}
            />
          </span>
        </motion.span>
      ) : (
        hovered &&
        !flyoutOpen &&
        !dragging && (
          <motion.span
            ref={labelRef}
            className="dock-label"
            data-edge={edge}
            initial={gamePaused ? false : { opacity: 0, scale: 0.98, ...labelFrom(edge) }}
            animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
            transition={gamePaused ? { duration: 0 } : { duration: 0.12, ease: "easeOut" }}
          >
            {item.name}
          </motion.span>
        )
      )}
      <motion.span className="dock-icon-float" data-solid-icon={!!item.iconSrc && solidIconSrc === item.iconSrc} style={{ scale: gamePaused ? 1 : scale }}>
        {item.kind === "stack" ? (
          <span className="dock-stack">
            {item.children.slice(0, 4).map((child, i) =>
              item.childIcons[i] ? (
                <img key={child.id} src={item.childIcons[i]!} alt="" draggable={false} />
              ) : (
                <span key={child.id} className="dock-stack-slot" />
              ),
            )}
          </span>
        ) : item.iconSrc && item.iconSrc !== failedIconSrc ? (
          <img ref={imageRef} src={item.iconSrc} alt="" draggable={false} onLoad={classifyIcon} onError={() => setFailedIconSrc(item.iconSrc)} />
        ) : (
          <span className="dock-icon-glyph">{initial}</span>
        )}
      </motion.span>
      {audio?.muted && (
        <span className="dock-muted-badge" title={`${item.name} is muted`}>
          <Speaker muted />
        </span>
      )}
      {item.windows.length > 0 && (
        <span className="dock-indicator" data-focused={item.focused} />
      )}
    </motion.button>
  );
}
