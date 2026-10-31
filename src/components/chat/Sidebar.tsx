"use client";

import { Bot, CircleAlert, Loader2, MessageSquare, Plus, Square, Trash2, X } from "lucide-react";
import { fmtTime } from "@/lib/store";
import type { Session } from "@/lib/store";

type SidebarProps = {
  sidebarOpen: boolean;
  sessions: Session[];
  activeId: string | null;
  runningIds: Record<string, string>;
  pendingApprovals: Record<string, { runId: string; id: string }>;
  onClose: () => void;
  onNewChat: () => void;
  onSwitchSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onStopSession: (id: string) => void;
};

export default function Sidebar({
  sidebarOpen,
  sessions,
  activeId,
  runningIds,
  pendingApprovals,
  onClose,
  onNewChat,
  onSwitchSession,
  onDeleteSession,
  onStopSession,
}: SidebarProps) {
  return (
    <aside
      className={`relative z-20 flex shrink-0 flex-col border-r border-white/10 bg-black backdrop-blur-2xl transition-all duration-300 ${
        sidebarOpen ? "w-80" : "w-0 overflow-hidden border-0"
      }`}
    >
      <div className="w-80 p-5 flex flex-col h-full overflow-y-auto">
        {/* logo */}
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-2xl bg-white shadow-lg shadow-white/10">
            <Bot size={20} className="text-black" />
          </div>
          <div>
            <p className="text-sm font-bold tracking-tight text-white">FarayAgent</p>
            <p className="text-[11px] text-zinc-400 flex items-center gap-1">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-white animate-pulse" />
              Browser Agent • v1.0
            </p>
          </div>
          <button
            onClick={onClose}
            className="ml-auto rounded-lg p-1.5 text-zinc-500 hover:bg-white/10 hover:text-white"
          >
            <X size={16} />
          </button>
        </div>

        {/* new chat */}
        <button
          onClick={onNewChat}
          className="mt-5 flex items-center justify-center gap-2 rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-black shadow-lg shadow-white/10 transition hover:bg-zinc-200 active:scale-[0.98]"
        >
          <Plus size={16} /> New chat
        </button>
        <div className="mt-6 mb-2 flex items-center gap-2">
          <p className="text-[11px] font-semibold tracking-widest text-zinc-500 uppercase">
            Chats
          </p>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
          {sessions.map((s) => {
            const isActive = s.id === activeId;
            const running = runningIds[s.id] !== undefined;
            const needsApproval = pendingApprovals[s.id] !== undefined;
            return (
              <div
                key={s.id}
                className={`group flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition active:scale-[0.98] ${
                  isActive
                    ? "border-white/40 bg-white/10"
                    : "border-transparent hover:bg-white/5"
                }`}
              >
                <button
                  onClick={() => onSwitchSession(s.id)}
                  aria-label={`Open chat: ${s.title}`}
                  aria-current={isActive ? "page" : undefined}
                  className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                >
                  {needsApproval ? (
                    <CircleAlert size={15} className="shrink-0 text-amber-300" />
                  ) : running ? (
                    <Loader2 size={15} className="shrink-0 animate-spin text-white" />
                  ) : (
                    <MessageSquare
                      size={15}
                      className={`shrink-0 ${isActive ? "text-white" : "text-zinc-600"}`}
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className={`truncate text-[13px] font-medium ${isActive ? "text-white" : "text-zinc-400"}`}>
                      {s.title}
                    </p>
                    <p className={`text-[10px] ${needsApproval ? "text-amber-300" : "text-zinc-600"}`}>
                      {needsApproval
                        ? "approval needed · click to review"
                        : running
                          ? "running in background…"
                          : `${s.messages.length} messages • ${fmtTime(s.updatedAt)}`}
                    </p>
                  </div>
                </button>
                {running && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onStopSession(s.id);
                    }}
                    title="Stop this run"
                    className="shrink-0 rounded-lg bg-white p-1.5 text-black transition hover:bg-zinc-200"
                  >
                    <Square size={11} fill="currentColor" />
                  </button>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteSession(s.id);
                  }}
                  title="Delete session"
                  className="shrink-0 rounded-lg p-1.5 text-zinc-600 opacity-0 transition group-hover:opacity-100 hover:bg-white/10 hover:text-white"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            );
          })}
          {sessions.length === 0 && (
            <p className="px-1 py-4 text-center text-xs text-zinc-600">
              No chats yet
            </p>
          )}
        </div>
      </div>
    </aside>
  );
}
