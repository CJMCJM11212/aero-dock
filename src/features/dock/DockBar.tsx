/**
 * The dock bar: a glass shelf of icons. Owns the cursor motion value the
 * icons magnify against, drag-reordering of the pinned section, and the
 * deterministic window-size report to Rust (window = dock + magnification
 * headroom + tooltip space + flyout space when a menu is open).
 */

import { AnimatePresence, motion, useMotionValue } from "motion/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { springs } from "../../engine/animation/springs";
import { ipc } from "../../ipc/commands";
import { Toasts } from "../feedback/Toasts";
import { notify, useToasts } from "../feedback/toastStore";
import type { Settings } from "../../ipc/types";
import type { DockItemView } from "../../state/dockStore";
import { useAmbient } from "../../state/ambientStore";
import { useFileDrag } from "../../state/dragStore";
import { useRunning } from "../../state/runningStore";
import { Welcome } from "../onboarding/Welcome";
import { SEARCH_PANEL, SearchOverlay, useSearch } from "../search/SearchOverlay";
import { WidgetCluster } from "../widgets/WidgetCluster";
import { ContextMenu } from "./ContextMenu";
import { SearchButton, SettingsButton } from "./DockControls";
import { MODE_FLYOUT_HEIGHT, ModeSwitcher, useModeSwitcher } from "./ModeSwitcher";
import { DockIcon } from "./DockIcon";
import { useDockResize } from "./useDockResize";
import { usePinnedReorder } from "./usePinnedReorder";
import { FolderFlyout } from "./FolderFlyout";
import { StackFlyout } from "./StackFlyout";
import { anchorFor, useMenu } from "./menuStore";
import "./dock.css";

const GAP = 18;
const PAD_MAIN = 30; // dock padding along the axis, including the resize corner
const PAD_CROSS = 10; // dock padding across the axis
const LABEL_SPACE = 100; // room for wrapped app names above icons
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
const MAX_ICON_SIZE = 128;

interface DockBarProps {
  settings: Settings;
  items: DockItemView[];
  onLaunch: (item: DockItemView) => void;
}

export function DockBar({ settings, items, onLaunch }: DockBarProps) {
  const { edge, magnification, magnificationScale } = settings.dock;
  const [moving, setMoving] = useState(false);
  const movingRef = useRef(false);
  const iconSize = settings.dock.iconSize;
  const vertical = edge === "left" || edge === "right";
  const mouseAxis = useMotionValue(Infinity);
  const gamePaused = useRunning((s) => s.immersiveActive);
  const menu = useMenu();
  const draggingRef = useRef(false);
  const reorderGeneration = useRef(0);
  const [dragging, setDragging] = useState(false);
  const beginResize = useCallback(() => {
    menu.close();
    mouseAxis.set(Infinity);
  }, [menu, mouseAxis]);
  const { viewportRef, resizeRef, resizing, startResize, finishResize, resizeKey } =
    useDockResize(iconSize, items.length, vertical, beginResize);
  const heldItems = useRef(items);
  if (!resizing && !dragging) heldItems.current = items;
  const shownItems = resizing || dragging ? heldItems.current : items;


  const pinnedItems = useMemo(() => shownItems.filter((i) => i.pinned), [shownItems]);
  const runningItems = useMemo(() => shownItems.filter((i) => !i.pinned), [shownItems]);

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
  useEffect(() => {
    if (!menu.item) return;
    const refresh = () => {
      const target = [...document.querySelectorAll<HTMLElement>("[data-dock-item]")]
        .find((element) => element.dataset.dockItem === menu.item?.id);
      if (target) useMenu.setState({ anchor: anchorFor(target) });
    };
    window.addEventListener("resize", refresh);
    return () => window.removeEventListener("resize", refresh);
  }, [menu.item]);
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
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const shrinkTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // A file drag aimed at the dock must not make it slide away.
  const fileDragOver = useFileDrag((s) => s.overDock);
  const expectedPinned = useFileDrag((s) => s.expectedPinned);
  const dropSlots = fileDragOver ? Math.max(0, expectedPinned - pinnedItems.length) : 0;

  // ambient-motion sleep: cheap idle, alive on approach
  const asleep = useAmbient((s) => s.asleep);
  const setAsleep = useAmbient((s) => s.setAsleep);
  const sleepTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    clearTimeout(sleepTimer.current);
    if (gamePaused) {
      mouseAxis.set(Infinity);
      setAsleep(true);
      return;
    }
    if (pointerInside || menuOpen || fileDragOver || resizing || moving) {
      setAsleep(false);
      return;
    }
    sleepTimer.current = setTimeout(() => setAsleep(true), SLEEP_AFTER_MS);
    return () => clearTimeout(sleepTimer.current);
  }, [pointerInside, menuOpen, fileDragOver, resizing, moving, gamePaused, mouseAxis, setAsleep]);

  // Asleep is also when the dock hands memory back. Chromium keeps its
  // raster caches until told otherwise; on a real desktop this took the
  // GPU process from about 125 MB to about 61 MB. Waking restores normal
  // behaviour before the cursor can notice.
  useEffect(() => {
    ipc.setMemorySaver(asleep || gamePaused).catch((e) => console.debug("memory saver unavailable", e));
  }, [asleep, gamePaused]);

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
    if (pointerInside || menuOpen || fileDragOver || resizing || moving) {
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
  }, [autoHide, pointerInside, menuOpen, fileDragOver, resizing, moving, autoHideDelay]);

  // Transform magnification needs constant end padding, not extra layout
  // width per icon. Keep cross-axis space constant so resizing stays anchored.
  const windowSize = useMemo(() => {
    const n = Math.max(shownItems.length + dropSlots, 1);
    const dividers = runningItems.length > 0 && pinnedItems.length > 0 ? 1 : 0;
    const mainBase = n * iconSize + (n - 1 + dividers) * GAP + dividers * 8 + PAD_MAIN * 2;
    // Constant space for transform magnification of the two end icons.
    const mainGrowth = MAX_ICON_SIZE * (peak - 1);
    const auxiliarySpace =
      (settings.dock.showSearchButton ? 48 : 0) +
      (settings.dock.showSettingsButton ? 48 : 0) +
      (settings.dock.showClock ? 90 : 0) +
      (settings.dock.showSystemStatus ? 65 : 0);
    const main = mainBase + mainGrowth + EDGE_SLACK + auxiliarySpace +
      (modesOn ? MODE_TILE_SPACE : 0);
    const label = vertical ? LABEL_SPACE_SIDE : LABEL_SPACE;
    // The dock band itself: icons at full magnification plus tooltip room.
    const band = MAX_ICON_SIZE * peak + PAD_CROSS * 2 + label;
    // Open surfaces are taller than the band. Each reports the total cross
    // size it needs, and the window takes the largest. The search overlay
    // is measured from its own geometry rather than a shared guess, because
    // a guess that is too small silently clips its input off the top.
    const crossFull = Math.max(
      band + MENU_SPACE,
      // the mode flyout is taller than the tooltip band it hangs off
      band + MODE_FLYOUT_HEIGHT + FLYOUT_GAP,
      SEARCH_PANEL.offsetFor(MAX_ICON_SIZE) + SEARCH_PANEL.height + FLYOUT_GAP,
      band + TOAST_SPACE,
    );
    const cross = windowShrunk ? REVEAL_STRIP : crossFull;
    return vertical ? { width: cross, height: main } : { width: main, height: cross };
  }, [
    shownItems.length,
    dropSlots,
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
  const geometryReady = useRef(false);
  useEffect(() => {
    if (resizeRef.current) return;
    const anchorStart = geometryReady.current;
    geometryReady.current = true;
    ipc.resizeDock(windowSize.width, windowSize.height, anchorStart).catch((e) => {
      // geometry is re-sent on every layout change; a single miss is
      // self-healing, so log it rather than interrupting the user
      console.warn("resize_dock failed", e);
    });
  }, [windowSize.width, windowSize.height, resizing, resizeRef]);

  // Opening a menu changes the native clipping region, never the window
  // bounds. A fixed canvas prevents WebView2 painting the old layout at a
  // new screen origin for one frame. Closed reserved space is not hit-testable.
  const visibleBand = MAX_ICON_SIZE * peak + PAD_CROSS * 2 +
    (vertical ? LABEL_SPACE_SIDE : LABEL_SPACE);
  useEffect(() => {
    ipc.setDockBand(visibleBand, menuOpen || toastCount > 0)
      .catch((error) => console.warn("dock clipping failed", error));
  }, [visibleBand, menuOpen, toastCount, edge]);

  const handleMove = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as Element).closest(".dock-resize-handle, .dock-move-handle")) {
        mouseAxis.set(Infinity);
        return;
      }
      if (!gamePaused && !draggingRef.current && !resizeRef.current && !menuOpen && !fileDragOver) mouseAxis.set(vertical ? e.clientY : e.clientX);
    },
    [gamePaused, mouseAxis, vertical, menuOpen, fileDragOver],
  );

  const handleLeave = useCallback(() => {
    mouseAxis.set(Infinity);
  }, [mouseAxis]);

  const openMenu = useCallback(
    (item: DockItemView, target: HTMLElement) => {
      mouseAxis.set(Infinity);
      menu.open("menu", item, anchorFor(target));
    },
    [menu, mouseAxis],
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
    dragging: dragging || resizing || moving || menuOpen || fileDragOver,
    gamePaused,
    onLaunch: launchGuarded,
    onContext: openMenu,
  };

  const reorder = usePinnedReorder({
    vertical,
    disabled: resizing || moving || menuOpen || fileDragOver,
    instant: gamePaused,
    onStart: () => {
      reorderGeneration.current++;
      draggingRef.current = true;
      setDragging(true);
      mouseAxis.set(Infinity);
    },
    onOrder: setOrder,
    onFinish: (ids) => {
      const generation = reorderGeneration.current;
      setDragging(false);
      const save = ids ? ipc.reorderPinned(ids) : Promise.resolve();
      save.catch(notify.on("Could not save the new order")).finally(() => {
        setTimeout(() => {
          if (generation === reorderGeneration.current) draggingRef.current = false;
        }, 50);
      });
    },
  });

  const startMove = useCallback((e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 || movingRef.current || resizeRef.current || draggingRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    menu.close();
    mouseAxis.set(Infinity);
    movingRef.current = true;
    setMoving(true);
    void (async () => {
      try {
        // Persist the current location first so the ZEUSLAP taskbar guard
        // stops correcting the window while Windows owns the native drag.
        await ipc.beginDockMove();
        await getCurrentWindow().startDragging();
        let saved = false;
        for (let attempt = 0; attempt < 300 && !saved; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 60));
          saved = await ipc.finishDockMove();
        }
        if (!saved) throw new Error("Dock move did not finish");
      } catch (error) {
        notify.error("Could not move dock", error);
      } finally {
        movingRef.current = false;
        setMoving(false);
      }
    })();
  }, [menu, mouseAxis]);

  const slideOut = vertical
    ? { x: edge === "left" ? "-118%" : "118%", y: 0 }
    : { y: edge === "top" ? "-118%" : "118%", x: 0 };

  return (
    <div
      ref={viewportRef}
      className="dock-viewport"
      data-edge={edge}
      data-asleep={asleep || gamePaused}
      data-resizing={resizing}
      style={{ "--icon-size": `${iconSize}px`, "--window-inset": `${(MAX_ICON_SIZE * (peak - 1) + EDGE_SLACK) / 2}px`, "--tooltip-clearance": `${Math.max(34, iconSize * (peak - 1) + 12)}px` } as CSSProperties}
      onMouseEnter={() => setPointerInside(true)}
      onMouseLeave={() => setPointerInside(false)}
    >
      <motion.div
        className="dock-bar glass glass-open"
        data-vertical={vertical}
        animate={hidden ? { ...slideOut, opacity: 0.6 } : { x: 0, y: 0, opacity: 1 }}
        transition={gamePaused ? { duration: 0 } : springs.slide}
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
        <div
          {...reorder}
          className="dock-section"
        >
          {orderedPinned.map((item) => (
            <div
              key={item.id}
              data-reorder-id={item.id}
            >
              <DockIcon item={item} {...iconProps} />
            </div>
          ))}
        </div>
        {dropSlots > 0 && (
          <motion.div
            className="dock-drop-slot"
            data-vertical={vertical}
            role="status"
            initial={vertical ? { height: 0, marginTop: -GAP, opacity: 0 } : { width: 0, marginLeft: -GAP, opacity: 0 }}
            animate={vertical ? { height: dropSlots * (iconSize + GAP) - GAP, marginTop: 0, opacity: 1 } : { width: dropSlots * (iconSize + GAP) - GAP, marginLeft: 0, opacity: 1 }}
            transition={{ duration: gamePaused ? 0 : 0.16, ease: "easeOut" }}
          >
            <span aria-hidden>＋</span><span>여기에 추가</span>
          </motion.div>
        )}
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
          className="dock-move-handle"
          type="button"
          aria-label="도크 위치 이동"
          title="드래그해서 위치 이동 · 방향키로 미세 조절 · Home으로 원위치"
          data-moving={moving}
          onPointerDown={startMove}
          onKeyDown={(e) => {
            const step = e.shiftKey ? 20 : 10;
            const delta = {
              ArrowLeft: [-step, 0], ArrowRight: [step, 0],
              ArrowUp: [0, -step], ArrowDown: [0, step],
            }[e.key];
            if (delta) {
              e.preventDefault();
              ipc.nudgeDock(delta[0], delta[1]).catch(notify.on("Could not move dock"));
            } else if (e.key === "Home") {
              e.preventDefault();
              ipc.resetDockPosition().catch(notify.on("Could not reset dock position"));
            }
          }}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M10 3.5v13M3.5 10h13M7.5 6 10 3.5 12.5 6M7.5 14 10 16.5l2.5-2.5M6 7.5 3.5 10 6 12.5M14 7.5l2.5 2.5-2.5 2.5" />
          </svg>
        </button>
        <button
          className="dock-resize-handle"
          type="button"
          aria-label="도크 크기 조절"
          title="드래그해서 도크 크기 조절"
          onPointerDown={startResize}
          onLostPointerCapture={finishResize}
          onKeyDown={resizeKey}
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
