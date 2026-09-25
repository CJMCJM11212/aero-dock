/**
 * True while Explorer is dragging files over the dock window.
 *
 * Auto-hide reads this: sliding the dock away mid-drag is the one moment
 * where hiding actively fights the user, because they are aiming at it.
 */

import { create } from "zustand";

interface DragState {
  /** A file drag is currently over the dock. */
  overDock: boolean;
  expectedPinned: number;
  begin: (baseCount: number, incomingCount: number) => void;
  setOverDock: (over: boolean) => void;
}

export const useFileDrag = create<DragState>((set) => ({
  overDock: false,
  expectedPinned: 0,
  begin: (baseCount, incomingCount) => set({ overDock: true, expectedPinned: baseCount + Math.max(1, incomingCount) }),
  setOverDock: (overDock) => set({ overDock }),
}));
