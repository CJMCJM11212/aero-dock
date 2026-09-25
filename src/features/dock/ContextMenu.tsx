/**
 * Aero context menu: a glass sheet that blooms open above the icon and
 * dissolves closed. Window list on top (for running apps), then actions.
 */

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { ipc } from "../../ipc/commands";
import { notify } from "../feedback/toastStore";
import type { AudioDevice, Settings } from "../../ipc/types";
import { exeKey, useAppAudio } from "../../state/audioStore";
import type { DockItemView } from "../../state/dockStore";
import { flyoutStyle, useMenu } from "./menuStore";
import "./contextmenu.css";

const MENU_WIDTH = 256;

/** The output an app is set to in the active mode, if any. */
function chosenDevice(settings: Settings, exe: string): string | null {
  const key = exeKey(exe);
  const mode = settings.modes.modes.find((m) => m.id === settings.modes.activeId);
  return mode?.audio.find((a) => a.exe === key)?.deviceId ?? null;
}

interface ContextMenuProps {
  settings: Settings;
  edge: Settings["dock"]["edge"];
}

interface Action {
  label: string;
  danger?: boolean;
  separatorAbove?: boolean;
  run: () => void | Promise<unknown>;
}

/** Merge a pinned item into (or onto) its left neighbor as a stack. */
async function stackWithPrevious(settings: Settings, itemId: string): Promise<unknown> {
  const pinned = structuredClone(settings.pinned);
  const idx = pinned.findIndex((p) => p.id === itemId);
  if (idx < 1) return;
  const current = pinned[idx];
  const prev = pinned[idx - 1];
  if (prev.kind === "stack") {
    prev.children.push(current);
  } else {
    pinned[idx - 1] = {
      id: `pin-${crypto.randomUUID()}`,
      kind: "stack",
      path: "",
      name: `${prev.name} 그룹`,
      icon: null,
      children: [prev, current],
    };
  }
  pinned.splice(idx, 1);
  const next = structuredClone(settings);
  next.pinned = pinned;
  return ipc.setSettings(next);
}

/** Explode a stack back into its pinned children. */
async function unstack(settings: Settings, stackId: string): Promise<unknown> {
  const pinned = structuredClone(settings.pinned);
  const idx = pinned.findIndex((p) => p.id === stackId);
  if (idx === -1) return;
  const stack = pinned[idx];
  pinned.splice(idx, 1, ...stack.children);
  const next = structuredClone(settings);
  next.pinned = pinned;
  return ipc.setSettings(next);
}

function buildActions(item: DockItemView, settings: Settings): Action[] {
  const actions: Action[] = [];

  // stacks have their own compact menu
  if (item.kind === "stack") {
    actions.push({ label: "그룹 해제", run: () => unstack(settings, item.id) });
    actions.push({
      label: "도크에서 제거",
      run: () => ipc.unpinItem(item.id),
    });
    actions.push({
      label: "도크 설정…",
      separatorAbove: true,
      run: () => ipc.openSettings(),
    });
    return actions;
  }

  actions.push({
    label: item.windows.length > 0 ? "새 창 열기" : "열기",
    run: () => ipc.launch(item.target, item.args),
  });
  actions.push({
    label: "관리자 권한으로 실행",
    run: () => ipc.launchAsAdmin(item.target, item.args),
  });
  actions.push({
    label: "파일 위치 열기",
    run: () => ipc.openFileLocation(item.target),
  });

  if (item.pinned) {
    actions.push({
      label: "도크에서 제거",
      separatorAbove: true,
      run: () => ipc.unpinItem(item.id),
    });
    const idx = settings.pinned.findIndex((p) => p.id === item.id);
    if (idx > 0) {
      actions.push({
        label:
          settings.pinned[idx - 1].kind === "stack"
            ? "왼쪽 그룹에 추가"
            : "왼쪽 앱과 그룹 만들기",
        run: () => stackWithPrevious(settings, item.id),
      });
    }
  } else {
    actions.push({
      label: "도크에 고정",
      separatorAbove: true,
      run: () =>
        ipc.pinItem(
          {
            id: `pin-${crypto.randomUUID()}`,
            kind: "app",
            path: item.target,
            name: item.name,
            icon: null,
            children: [],
          },
          settings.pinned.length,
        ),
    });
  }

  actions.push({
    label: "도크 설정…",
    separatorAbove: true,
    run: () => ipc.openSettings(),
  });

  if (item.windows.length === 1) {
    actions.push({
      label: "최소화",
      separatorAbove: true,
      run: () => ipc.minimizeWindow(item.windows[0].hwnd),
    });
    actions.push({
      label: "창 닫기",
      danger: true,
      run: () => ipc.closeWindow(item.windows[0].hwnd),
    });
  } else if (item.windows.length > 1) {
    actions.push({
      label: `창 모두 닫기 (${item.windows.length})`,
      danger: true,
      separatorAbove: true,
      run: () => Promise.all(item.windows.map((w) => ipc.closeWindow(w.hwnd))),
    });
  }

  return actions;
}

export function ContextMenu({ settings, edge }: ContextMenuProps) {
  const { kind, item: openItem, anchor, close } = useMenu();
  const item = kind === "menu" ? openItem : null;

  const audio = useAppAudio((a) => (item ? a.levels[exeKey(item.audioExe)] : undefined));
  const toggleMute = useAppAudio((a) => a.toggleMute);
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [showDevices, setShowDevices] = useState(false);

  // collapse the device list whenever the menu moves to another icon
  useEffect(() => {
    setShowDevices(false);
  }, [item?.id]);

  // endpoints are only listed once the user asks for them
  useEffect(() => {
    if (!showDevices || devices.length > 0) return;
    ipc
      .listAudioDevices()
      .then(setDevices)
      .catch((e) => console.warn("audio device list failed", e));
  }, [showDevices, devices.length]);

  // close on any click outside / Escape
  useEffect(() => {
    if (!item) return;
    const onDown = (e: MouseEvent) => {
      // Right-click switches the existing menu at contextmenu time. Closing
      // on its preceding mousedown shrinks and regrows the native WebView.
      if (e.button === 2 && (e.target as HTMLElement).closest(".dock-icon")) return;
      if (!(e.target as HTMLElement).closest(".aero-menu")) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
        [...document.querySelectorAll<HTMLElement>("[data-dock-item]")]
          .find((el) => el.dataset.dockItem === item.id)?.focus({ preventScroll: true });
      }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
        e.preventDefault();
        const buttons = [...document.querySelectorAll<HTMLButtonElement>(".aero-menu button")];
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const index = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1
          : (current + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[index]?.focus({ preventScroll: true });
        buttons[index]?.scrollIntoView({ block: "nearest" });
      }
    };
    // clicks outside the OS window never reach us, so also dismiss when
    // the cursor leaves the window and doesn't come back promptly
    let leaveTimer: ReturnType<typeof setTimeout> | undefined;
    const onLeave = () => {
      leaveTimer = setTimeout(close, 450);
    };
    const onEnter = () => clearTimeout(leaveTimer);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    document.documentElement.addEventListener("mouseleave", onLeave);
    document.documentElement.addEventListener("mouseenter", onEnter);
    return () => {
      clearTimeout(leaveTimer);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
      document.documentElement.removeEventListener("mouseleave", onLeave);
      document.documentElement.removeEventListener("mouseenter", onEnter);
    };
  }, [item, close]);

  const style = anchor ? flyoutStyle(edge, anchor, MENU_WIDTH, 12, 440) : {};

  return (
    <AnimatePresence>
      {item && anchor && (
        <motion.div
          className="aero-menu"
          role="menu"
          aria-label={`${item.name} 메뉴`}
          style={style}
          initial={{ opacity: 0, y: edge === "bottom" ? 4 : -4 }}
          animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
          exit={{ opacity: 0, transition: { duration: 0 } }}
          transition={{ duration: 0.12, ease: "easeOut" }}
        >
          {item.windows.length > 1 && (
            <div className="aero-menu-windows">
              {item.windows.slice(0, 6).map((w) => (
                <button role="menuitem"
                  key={w.hwnd}
                  className="aero-menu-item aero-menu-window"
                  onClick={() => {
                    ipc.activateWindow(w.hwnd).catch(notify.on("창을 활성화하지 못했어요"));
                    close();
                  }}
                >
                  <span className="aero-menu-window-title">{w.title}</span>
                </button>
              ))}
              <div className="aero-menu-separator" />
            </div>
          )}
          {item.kind !== "stack" && (
            <div className="aero-menu-audio">
              {audio && (
                <button role="menuitem"
                  className="aero-menu-item"
                  onClick={() => {
                    void toggleMute(item.audioExe);
                    close();
                  }}
                >
                  {audio.muted ? "음소거 해제" : "음소거"}
                  <span className="aero-menu-hint">
                    {audio.muted ? "음소거됨" : `${audio.volume}%`}
                  </span>
                </button>
              )}
              <button role="menuitem"
                className="aero-menu-item"
                aria-expanded={showDevices}
                onClick={() => setShowDevices((v) => !v)}
              >
                소리 출력
                <span className="aero-menu-hint">{showDevices ? "접기" : "선택"}</span>
              </button>
              {showDevices && (
                <div className="aero-menu-devices">
                  {devices.length === 0 && (
                    <div className="aero-menu-note">출력 장치를 찾는 중…</div>
                  )}
                  {devices.map((d) => {
                    const current = chosenDevice(settings, item.audioExe);
                    const active = current === null ? d.isDefault : current === d.id;
                    return (
                      <button role="menuitem"
                        key={d.id}
                        className="aero-menu-item aero-menu-device"
                        data-active={active}
                        onClick={() => {
                          ipc
                            .setAppOutputDevice(item.audioExe, d.id, true)
                            .then((choice) => {
                              if (choice.openedSettings) {
                                notify.info(
                                  `열린 Windows 설정에서 ${item.name}의 출력 장치를 ${d.name}(으)로 선택하세요.`,
                                );
                              } else {
                                notify.info(`${item.name}의 출력 장치를 ${d.name}(으)로 저장했어요.`);
                              }
                            })
                            .catch(notify.on("소리 출력을 변경하지 못했어요"));
                          close();
                        }}
                      >
                        <span className="aero-menu-device-name">{d.name}</span>
                        {d.isDefault && <span className="aero-menu-hint">기본</span>}
                      </button>
                    );
                  })}
                  <div className="aero-menu-note">
                    출력 장치 연결은 Windows 설정에서 마무리할 수 있어요.
                  </div>
                </div>
              )}
              <div className="aero-menu-separator" />
            </div>
          )}
          {buildActions(item, settings).map((action) => (
            <div key={action.label}>
              {action.separatorAbove && <div className="aero-menu-separator" />}
              <button role="menuitem"
                className="aero-menu-item"
                data-danger={action.danger}
                onClick={() => {
                  Promise.resolve(action.run()).catch(
                    notify.on(`“${action.label}” 실행 실패`),
                  );
                  close();
                }}
              >
                {action.label}
              </button>
            </div>
          ))}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
