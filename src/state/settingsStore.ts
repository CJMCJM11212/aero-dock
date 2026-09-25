/**
 * Settings state: hydrated once from Rust, then kept in sync by the
 * `settings://changed` event. Mutations go through Rust and come back as
 * events, so this store never diverges from the persisted truth.
 */

import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { ipc } from "../ipc/commands";
import { EVENTS, type Settings } from "../ipc/types";

interface SettingsState {
  settings: Settings | null;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  /** Apply a partial change on top of current settings and persist. */
  apply: (mutate: (draft: Settings) => void) => Promise<void>;
}

let hydrationPromise: Promise<void> | null = null;

async function readInitialSettings(): Promise<Settings> {
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      return await ipc.getSettings();
    } catch (error) {
      // The WebView can start its first render before Tauri's setup has
      // registered SettingsStore. Retry only that startup race.
      if (!String(error).includes("state not managed for field `store`") || Date.now() >= deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
  }
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: null,
  hydrated: false,

  hydrate: () => {
    if (get().hydrated) return Promise.resolve();
    if (hydrationPromise) return hydrationPromise;
    const current = (async () => {
      const settings = await readInitialSettings();
      await listen<Settings>(EVENTS.settingsChanged, (event) => {
        set({ settings: event.payload });
      });
      set({ settings, hydrated: true });
    })();
    hydrationPromise = current;
    void current.then(
      () => { if (hydrationPromise === current) hydrationPromise = null; },
      () => { if (hydrationPromise === current) hydrationPromise = null; },
    );
    return current;
  },

  apply: async (mutate) => {
    const current = get().settings;
    if (!current) return;
    const draft: Settings = structuredClone(current);
    mutate(draft);
    // optimistic update; the confirmed struct arrives via the event
    set({ settings: draft });
    await ipc.setSettings(draft);
  },
}));
