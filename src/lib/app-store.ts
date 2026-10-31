"use client";

import { create } from "zustand";
import { Session, Settings, defaultSettings, saveSettings } from "./store";

type AppState = {
  settings: Settings;
  sessions: Session[];
  activeId: string | null;
  // Background runs: sessionId -> runId ("" while connecting). Survives
  // remounts so the sidebar can badge sessions with live runs.
  runningIds: Record<string, string>;
  // Pending approvals per session, so leaving a session auto-denies
  // instead of hanging the run forever.
  pendingApprovals: Record<string, { runId: string; id: string }>;
  setSettings: (settings: Settings) => void;
  setSessions: (sessions: Session[] | ((previous: Session[]) => Session[])) => void;
  setActiveId: (activeId: string | null) => void;
  setRunning: (sessionId: string, runId: string | null) => void;
  setPendingApproval: (sessionId: string, approval: { runId: string; id: string } | null) => void;
};

export const useAppStore = create<AppState>((set) => ({
  settings: defaultSettings(),
  sessions: [],
  activeId: null,
  runningIds: {},
  pendingApprovals: {},
  // Satu sumber kebenaran: setiap perubahan settings langsung ditulis ke
  // localStorage, jadi /chat dan halaman lain tidak perlu reload.
  setSettings: (settings) => {
    saveSettings(settings);
    set({ settings });
  },
  setSessions: (sessions) =>
    set((state) => ({
      sessions: typeof sessions === "function" ? sessions(state.sessions) : sessions,
    })),
  setActiveId: (activeId) => set({ activeId }),
  setRunning: (sessionId, runId) =>
    set((state) => {
      const runningIds = { ...state.runningIds };
      if (runId === null) delete runningIds[sessionId];
      else runningIds[sessionId] = runId;
      return { runningIds };
    }),
  setPendingApproval: (sessionId, approval) =>
    set((state) => {
      const pendingApprovals = { ...state.pendingApprovals };
      if (approval === null) delete pendingApprovals[sessionId];
      else pendingApprovals[sessionId] = approval;
      return { pendingApprovals };
    }),
}));
