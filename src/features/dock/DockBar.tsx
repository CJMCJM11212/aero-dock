/**
 * The dock bar: a glass shelf of icons. Owns the cursor motion value the
 * icons magnify against, drag-reordering of the pinned section, and the
 * deterministic window-size report to Rust (window = dock + magnification
 * headroom + tooltip space + flyout space when a menu is open).
 */

import { AnimatePresence, motion, Reorder, useMotionValue } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { springs } from "../../engine/animation/springs";
import { ipc } from "../../ipc/commands";
import { Toasts } from "../feedback/Toasts";
import { notify, useToasts } from "../feedback/toastStore";
import type { Settings } from "../../ipc/types";
import type { DockItemView } from "../../state/dockStore";
import { useAmbient } from "../../state/ambientStore";
import { useFileDrag } from "../../state/dragStore";
import { useSettings } from "../../state/settingsStore";
import { Welcome } from "../onboarding/Welcome";
import { SEARCH_PANEL, SearchOverlay, useSearch } from "../search/SearchOverlay";
import { WidgetCluster } from "../widgets/WidgetCluster";
import { ContextMenu } from "./ContextMenu";
import { SearchButton, SettingsButton } from "./DockControls";
import { MODE_FLYOUT_HEIGHT, ModeSwitcher, useModeSwitcher } from "./ModeSwitcher";
import { DockIcon } from "./DockIcon";
import { FolderFlyout } from "./FolderFlyout";
import { StackFlyout } from "./StackFlyout";
import { anchorFor, useMenu } from "./menuStore";
import "./dock.css";

const GAP = 18;
const PAD_MAIN = 30; // dock padding along the axis, including the resize corner
const PAD_CROSS = 10; // dock padding across the axis
const LABEL_SPACE = 44; // tooltip pill above icons (horizontal dock)
const LABEL_SPACE_SIDE = 150; // tooltip pill beside icons (vertical dock)
const EDGE_SLACK = 24; // window slack so magnified end-icons never clip
const MENU_SPACE = 360; // extra cross-axis room while a context menu is open
const FLYOUT_GAP = 16; // breathing room between a flyout and the window edge
const TOAST_SPACE = 210; // extra cross-axis room while toasts are on screen
const MODE_TILE_SPACE = 38; // the Modes tile, when Modes is switched on
const REVEAL_STRIP = 8; // window height while auto-hidden (mouse sensor)
// fallback only; the real delay is settings.dock.autoHideDelayMs
const HIDE_ANIM_MS = 380;
// ambient animations (float, sweep) pause after this much no-interaction
// so an idle dock costs ~zero GPU; they wake the moment the cursor returns
const SLEEP_AFTER_MS = 45_000;
const MIN_ICON_SIZE = 32;
const MAX_ICON_SIZE = 128;

interface DockBarProps {
  settings: Settings;
  items: DockItemView[];
  onLaunch: (item: DockItemView) => void;
}

export function DockBar({ settings, items, onLaunch }: DockBarProps) {
  const { edge, magnification, magnificationScale } = settings.dock;
  const [resizeSize, setResizeSize] = useState<number | null>(null);
  const [resizing, setResizing] = useState(false);
  const resizeRef = useRef<{ pointerId: number; startAxis: number; startSize: number; currentSize: number } | null>(null);
  const iconSize = resizeSize ?? settings.dock.iconSize;
  const vertical = edge === "left" || edge === "right";
  const mouseAxis = useMotionValue(Infinity);
  const menu = useMenu();
  const draggingRef = useRef(false);

  const pinnedItems = useMemo(() => items.filter((i) => i.pinned), [items]);
  const runningItems = useMemo(() => items.filter((i) => !i.pinned), [items]);

  // Local order during a drag; resynced from settings between drags.
  const [order, setOrder] = useState<string[]>(() => pinnedItems.map((i) => i.id));
  useEffect(() => {
    if (!draggingRef.current) setOrder(pinnedItems.map((i) => i.id));
  }, [pinnedItems]);

  const orderedPinned = useMemo(() => {
    const byId = new Map(pinnedItems.map((i) => [i.id, i]));
    const seq = order.map((id) => byId.get(id)).filter(Boolean) as DockItemView[];
    for (const item of pinnedItems) if (!order.includes(item.id)) seq.push(item);
    return seq;
  }, [order, pinnedItems]);

  const peak = magnification ? magnificationScale : 1;
  const searchOpen = useSearch((s) => s.open);
  const setSearchOpen = useSearch((s) => s.setOpen);
  const welcomeOpen = !settings.onboardingComplete && pinnedItems.length === 0;
  const modesOpen = useModeSwitcher((m) => m.open);
  const modesOn = settings.modes.enabled && settings.modes.modes.length > 0;
  const menuOpen = menu.item !== null || searchOpen || welcomeOpen || modesOpen;
  // toasts sit in the band above the dock, which is only tall enough for a
  // tooltip — without extra room the window would clip them
  const toastCount = useToasts((s) => s.items.length);

  // ---- auto-hide state machine ----
  // hidden=false + hover/menu keeps it visible; idle slides it out,
  // then the window shrinks to a reveal strip; any mouse contact with
  // the strip brings it back.
  const [hidden, setHidden] = useState(false);
  const [windowShrunk, setWindowShrunk] = useState(false);
  const [pointerInside, setPointerInside] = useState(false);
  const [dragging, setDragging] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const shrinkTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // A file drag aimed at the dock must not make it slide away.
  const fileDragOver = useFileDrag((s) => s.overDock);

  // ambient-motion sleep: cheap idle, alive on approach
  const asleep = useAmbient((s) => s.asleep);
  const setAsleep = useAmbient((s) => s.setAsleep);
  const sleepTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    clearTimeout(sleepTimer.current);
    if (pointerInside || menuOpen || fileDragOver || resizing) {
      setAsleep(false);
      return;
    }
    sleepTimer.current = setTimeout(() => setAsleep(true), SLEEP_AFTER_MS);
    return () => clearTimeout(sleepTimer.current);
  }, [pointerInside, menuOpen, fileDragOver, resizing, setAsleep]);

  // Asleep is also when the dock hands memory back. Chromium keeps its
  // raster caches until told otherwise; on a real desktop this took the
  // GPU process from about 125 MB to about 61 MB. Waking restores normal
  // behaviour before the cursor can notice.
  useEffect(() => {
    ipc.setMemorySaver(asleep).catch((e) => console.debug("memory saver unavailable", e));
  }, [asleep]);

  const autoHide = settings.dock.autoHide;
  const autoHideDelay = settings.dock.autoHideDelayMs;
  useEffect(() => {
    clearTimeout(hideTimer.current);
    clearTimeout(shrinkTimer.current);
    if (!autoHide) {
      setHidden(false);
      setWindowShrunk(false);
      return;
    }
    if (pointerInside || menuOpen || fileDragOver || resizing) {
      setHidden(false);
      setWindowShrunk(false);
      return;
    }
    hideTimer.current = setTimeout(() => {
      setHidden(true);
      // shrink the OS window only after the slide-out finishes
      shrinkTimer.current = setTimeout(() => setWindowShrunk(true), HIDE_ANIM_MS);
    }, autoHideDelay);
    return () => {
      clearTimeout(hideTimer.current);
      clearTimeout(shrinkTimer.current);
    };
  }, [autoHide, pointerInside, menuOpen, fileDragOver, resizing, autoHideDelay]);

  // Deterministic window size: no ResizeObserver, no feedback loops.
  const windowSize = useMemo(() => {
    const n = Math.max(items.length, 1);
    const dividers = runningItems.length > 0 && pinnedItems.length > 0 ? 1 : 0;
    const mainBase = n * iconSize + (n - 1 + dividers) * GAP + dividers * 8 + PAD_MAIN * 2;
    // neighbors near the cursor grow too; ~2.5 icons' worth covers the worst case
    const mainGrowth = iconSize * (peak - 1) * 2.5;
    const auxiliarySpace =
      (settings.dock.showSearchButton ? 48 : 0) +
      (settings.dock.showSettingsButton ? 48 : 0) +
      (settings.dock.showClock ? 90 : 0) +
      (settings.dock.showSystemStatus ? 65 : 0);
    const main = mainBase + mainGrowth + EDGE_SLACK + auxiliarySpace +
      (modesOn ? MODE_TILE_SPACE : 0);
    const label = vertical ? LABEL_SPACE_SIDE : LABEL_SPACE;
    // The dock band itself: icons at full magnification plus tooltip room.
    const band = iconSize * peak + PAD_CROSS * 2 + label;
    // Open surfaces are taller than the band. Each reports the total cross
    // size it needs, and the window takes the largest. The search overlay
    // is measured from its own geometry rather than a shared guess, because
    // a guess that is too small silently clips its input off the top.
    const crossFull = Math.max(
      band,
      menu.item !== null || welcomeOpen ? band + MENU_SPACE : 0,
      // the mode flyout is taller than the tooltip band it hangs off
      modesOpen ? band + MODE_FLYOUT_HEIGHT + FLYOUT_GAP : 0,
      searchOpen
        ? SEARCH_PANEL.offsetFor(iconSize) + SEARCH_PANEL.height + FLYOUT_GAP
        : 0,
      toastCount > 0 ? band + TOAST_SPACE : 0,
    );
    const cross = windowShrunk ? REVEAL_STRIP : crossFull;
    return vertical ? { width: cross, height: main } : { width: main, height: cross };
  }, [
    items.length,
    runningItems.length,
    iconSize,
    peak,
    vertical,
    menu.item,
    searchOpen,
    welcomeOpen,
    toastCount,
    windowShrunk,
    modesOn,
    modesOpen,
    settings.dock.showSearchButton,
    settings.dock.showSettingsButton,
    settings.dock.showClock,
    settings.dock.showSystemStatus,
  ]);

  useEffect(() => {
    ipc.resizeDock(windowSize.width, windowSize.height).catch((e) => {
      // geometry is re-sent on every layout change; a single miss is
      // self-healing, so log it rather than interrupting the user
      console.warn("resize_dock failed", e);
    });
  }, [windowSize.width, windowSize.height]);

  const handleMove = useCallback(
    (e: React.MouseEvent) => {
      if (!draggingRef.current && !resizeRef.current) mouseAxis.set(vertical ? e.clientY : e.clientX);
    },
    [mouseAxis, vertical],
  );

  const handleLeave = useCallback(() => {
    mouseAxis.set(Infinity);
  }, [mouseAxis]);

  const openMenu = useCallback(
    (item: DockItemView, target: HTMLElement) => {
      menu.open("menu", item, anchorFor(target));
    },
    [menu],
  );

  const launchGuarded = useCallback(
    (item: DockItemView, target?: HTMLElement) => {
      if (draggingRef.current) return;
      if (item.kind === "folder" && target) {
        menu.open("folder", item, anchorFor(target));
        return;
      }
      if (item.kind === "stack" && target) {
        menu.open("stack", item, anchorFor(target));
        return;
      }
      onLaunch(item);
    },
    [onLaunch, menu],
  );

  const iconProps = {
    mouseAxis,
    iconSize,
    magnify: magnification,
    magScale: magnificationScale,
    vertical,
    edge,
    dragging: dragging || resizing,
    onLaunch: launchGuarded,
    onContext: openMenu,
  };

  const saveIconSize = useCallback(async (size: number) => {
    const before = useSettings.getState().settings;
    if (!before || size === before.dock.iconSize) {
      setResizeSize(null);
      return;
    }
    try {
      await useSettings.getState().apply((draft) => { draft.dock.iconSize = size; });
    } catch (error) {
      useSettings.setState({ settings: before });
      notify.error("Could not save dock size", error);
    } finally {
      setResizeSize(null);
    }
  }, []);

  const startResize = useCallback((e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    menu.close();
    mouseAxis.set(Infinity);
    resizeRef.current = {
      pointerId: e.pointerId,
      startAxis: vertical ? e.screenY : e.screenX,
      startSize: iconSize,
      currentSize: iconSize,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    setResizing(true);
  }, [iconSize, menu, mouseAxis, vertical]);

  const moveResize = useCallback((e: PointerEvent<HTMLButtonElement>) => {
    const drag = resizeRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const delta = (vertical ? e.screenY : e.screenX) - drag.startAxis;
    const slots = Math.max(items.length, 1);
    const next = Math.max(MIN_ICON_SIZE, Math.min(MAX_ICON_SIZE,
      Math.round((drag.startSize + delta * 2 / slots) / 2) * 2));
    if (next === drag.currentSize) return;
    drag.currentSize = next;
    setResizeSize(next);
  }, [items.length, vertical]);

  const finishResize = useCallback((e: PointerEvent<HTMLButtonElement>) => {
    const drag = resizeRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    resizeRef.current = null;
    setResizing(false);
    if (e.type === "pointercancel") {
      setResizeSize(null);
    } else {
      void saveIconSize(drag.currentSize);
    }
  }, [saveIconSize]);

  const slideOut = vertical
    ? { x: edge === "left" ? "-118%" : "118%", y: 0 }
    : { y: edge === "top" ? "-118%" : "118%", x: 0 };

  return (
    <div
      className="dock-viewport"
      data-edge={edge}
      data-asleep={asleep}
      style={{ "--icon-size": `${iconSize}px` } as CSSProperties}
      onMouseEnter={() => setPointerInside(true)}
      onMouseLeave={() => setPointerInside(false)}
    >
      <motion.div
        className="dock-bar glass glass-open"
        data-vertical={vertical}
        animate={hidden ? { ...slideOut, opacity: 0.6 } : { x: 0, y: 0, opacity: 1 }}
        transition={springs.slide}
        onMouseMove={handleMove}
        onMouseLeave={handleLeave}
      >
        {/* the bar can't clip itself (tooltips float above it), so the
            ambient sweep gets its own clipping layer */}
        <span className="glass-sweep" aria-hidden />
        <ModeSwitcher settings={settings} edge={edge} />
        {settings.dock.showSearchButton && (
          <SearchButton onClick={() => setSearchOpen(!searchOpen)} />
        )}
        <Reorder.Group
          as="div"
          className="dock-section"
          axis={vertical ? "y" : "x"}
          values={order}
          onReorder={setOrder}
        >
          {orderedPinned.map((item) => (
            <Reorder.Item
              as="div"
              key={item.id}
              value={item.id}
              /* Only the siblings animate. Momentum and elasticity both
                 make the dragged tile trail the cursor, which is what
                 read as lag, so the tile itself tracks 1:1. */
              transition={springs.reorder}
              dragMomentum={false}
              dragElastic={0.04}
              whileDrag={{ zIndex: 30 }}
              onDragStart={() => {
                draggingRef.current = true;
                setDragging(true);
                mouseAxis.set(Infinity);
              }}
              onDragEnd={() => {
                ipc.reorderPinned(order).catch(notify.on("Could not save the new order"));
                setDragging(false);
                // let the trailing click event pass before re-enabling launch
                setTimeout(() => {
                  draggingRef.current = false;
                }, 50);
              }}
            >
              <DockIcon item={item} {...iconProps} />
            </Reorder.Item>
          ))}
        </Reorder.Group>
        {runningItems.length > 0 && pinnedItems.length > 0 && (
          <span className="dock-divider" aria-hidden />
        )}
        {runningItems.map((item) => (
          <DockIcon key={item.id} item={item} {...iconProps} />
        ))}
        {(settings.dock.showClock || settings.dock.showSystemStatus) && (
          <span className="dock-divider" aria-hidden />
        )}
        <WidgetCluster
          showClock={settings.dock.showClock}
          showStatus={settings.dock.showSystemStatus}
        />
        {settings.dock.showSettingsButton && (
          <SettingsButton
            onClick={() => ipc.openSettings().catch(notify.on("Could not open settings"))}
          />
        )}
        <button
          className="dock-resize-handle"
          type="button"
          aria-label="도크 크기 조절"
          title="드래그해서 도크 크기 조절"
          onPointerDown={startResize}
          onPointerMove={moveResize}
          onPointerUp={finishResize}
          onPointerCancel={finishResize}
          onLostPointerCapture={finishResize}
          onKeyDown={(e) => {
            if (e.key === "Escape" && resizeRef.current) {
              e.preventDefault();
              const pointerId = resizeRef.current.pointerId;
              resizeRef.current = null;
              setResizing(false);
              setResizeSize(null);
              if (e.currentTarget.hasPointerCapture(pointerId)) e.currentTarget.releasePointerCapture(pointerId);
              return;
            }
            if (e.key !== "ArrowRight" && e.key !== "ArrowUp" &&
                e.key !== "ArrowLeft" && e.key !== "ArrowDown") return;
            e.preventDefault();
            const direction = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : -1;
            void saveIconSize(Math.max(MIN_ICON_SIZE, Math.min(MAX_ICON_SIZE, iconSize + direction * 2)));
          }}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M8 15.5 15.5 8M12 15.5l3.5-3.5" />
          </svg>
        </button>
      </motion.div>
      <ContextMenu settings={settings} edge={edge} />
      <FolderFlyout edge={edge} />
      <StackFlyout edge={edge} />
      <SearchOverlay edge={edge} />
      <Toasts edge={edge} />
      <AnimatePresence>{welcomeOpen && <Welcome edge={edge} />}</AnimatePresence>
    </div>
  );
}
