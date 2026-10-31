"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { cssMs } from "@/lib/css-duration";
import type { Session } from "@/lib/store";
import type { Msg } from "@/components/chat/types";

type SearchModalProps = {
  sessions: Session[];
  searchQuery: string;
  setSearchQuery: (v: string) => void;
  onClose: () => void;
  onPick: (sessionId: string) => void;
};

// transitions-dev 06-modal orchestration, adapted to React: the modal mounts
// without .is-open, double-rAF adds it (open clock); on close .is-open is
// swapped for .is-closing and the parent unmounts us after --modal-close-dur.
export default function SearchModal({ sessions, searchQuery, setSearchQuery, onClose, onPick }: SearchModalProps) {
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        document.querySelector(".t-modal")?.classList.add("is-open");
        document.querySelector(".t-modal-overlay")?.classList.add("is-open");
      })
    );
    return () => {
      cancelAnimationFrame(raf);
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, []);

  function requestClose() {
    if (closing) return;
    setClosing(true);
    document.querySelector(".t-modal")?.classList.replace("is-open", "is-closing");
    document.querySelector(".t-modal-overlay")?.classList.replace("is-open", "is-closing");
    const closeMs = cssMs("--modal-close-dur", 150);
    closeTimer.current = setTimeout(onClose, closeMs);
  }

  return (
    <div className="t-modal-overlay fixed inset-0 z-50 grid place-items-start bg-black/70 p-4 pt-[12vh] backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) requestClose(); }}>
      <div className="t-modal glass w-full max-w-xl rounded-2xl p-4 shadow-2xl" role="dialog" aria-modal="true">
        <div className="flex items-center gap-3">
          <input
            autoFocus
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
             placeholder="Search chat history..."
            className="w-full bg-transparent text-sm text-white outline-none placeholder:text-zinc-600"
          />
          <button onClick={requestClose} className="text-zinc-500 hover:text-white"><X size={16} /></button>
        </div>
        <div className="mt-3 max-h-72 overflow-y-auto">
          {sessions
            .flatMap((s) => [...s.messages].reverse().map((m) => ({ session: s, message: m } as { session: Session; message: Msg })))
            .filter(({ message }) => !searchQuery.trim() || message.content.toLowerCase().includes(searchQuery.toLowerCase()))
            .slice(0, 30).map(({ session, message }, i) => (
              <button key={`${session.id}-${i}`} onClick={() => onPick(session.id)} className="block w-full rounded-xl px-3 py-2 text-left hover:bg-white/10">
                <span className="text-[10px] text-zinc-500">{session.title}</span>
                <span className="mt-0.5 block truncate text-sm text-zinc-200">{message.content}</span>
              </button>
            ))}
        </div>
      </div>
    </div>
  );
}
