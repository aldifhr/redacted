/* eslint-disable @next/next/no-img-element */
"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Loader2, MonitorPlay, RotateCw, X } from "lucide-react";

type LiveState = "connecting" | "live" | "ended" | "error";

type Frame = {
  data: string;
  url: string;
  width: number;
  height: number;
};

type Size = { width: number; height: number };

const MIN_W = 300;
const MIN_H = 200;
const DEFAULT_SIZE: Size = { width: 680, height: 430 };
const SIZE_KEY = "pw_liveview_size_v1";
const COLLAPSED_KEY = "pw_liveview_collapsed_v1";

function loadSize(): Size {
  try {
    const raw = localStorage.getItem(SIZE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Size>;
      const width = Number(p.width);
      const height = Number(p.height);
      if (Number.isFinite(width) && Number.isFinite(height) && width >= MIN_W && height >= MIN_H) {
        return { width, height };
      }
    }
  } catch {}
  return DEFAULT_SIZE;
}

function loadCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export default function LiveView({
  runId,
  onClose,
}: {
  runId?: string;
  onClose: () => void;
}) {
  const [state, setState] = useState<LiveState>("connecting");
  const [frame, setFrame] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  // ukuran panel — bisa di-drag dari grip kiri-atas, dan diingat antar sesi
  const [size, setSize] = useState<Size>(DEFAULT_SIZE);
  const [collapsed, setCollapsed] = useState(false);
  const dragRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

  // hidrasi deferred agar render pertama identik SSR
  useEffect(() => {
    const t = setTimeout(() => {
      setSize(loadSize());
      setCollapsed(loadCollapsed());
    }, 0);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    let buffer = "";
    (async () => {
      try {
        const qs = runId ? `?runId=${encodeURIComponent(runId)}` : "";
        const res = await fetch(`/api/browser/live${qs}`, {
          signal: ac.signal,
          headers: { Accept: "text/event-stream" },
        });
        if (!res.ok || !res.body) {
          throw new Error(`live view failed (${res.status})`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split("\n\n");
          buffer = chunks.pop() ?? "";
          for (const chunk of chunks) {
            const event = /^event: (.+)$/m.exec(chunk)?.[1];
            const payload = /^data: (.+)$/m.exec(chunk)?.[1];
            if (!event) continue;
            if (event === "frame" && payload) {
              const f = JSON.parse(payload) as Frame;
              setFrame(`data:image/jpeg;base64,${f.data}`);
              setUrl(f.url);
              setState("live");
            } else if (event === "error" && payload) {
              const parsed = JSON.parse(payload) as { message?: string };
              setError(parsed.message ?? "live view failed");
              setState("error");
            } else if (event === "end") {
              setState("ended");
            }
          }
        }
        setState((s) => (s === "error" ? s : "ended"));
      } catch (e) {
        if (!ac.signal.aborted) {
          setState("error");
          setError(e instanceof Error ? e.message : "live view failed");
        }
      }
    })();
    return () => ac.abort();
  }, [runId, attempt]);

  function persistSize(next: Size) {
    try {
      localStorage.setItem(SIZE_KEY, JSON.stringify(next));
    } catch {}
  }

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
      } catch {}
      return next;
    });
  }

  // Panel ter-anchor kanan-bawah: grip kiri-atas, drag ke kiri/atas = membesar.
  function onGripDown(e: React.PointerEvent<HTMLButtonElement>) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, w: size.width, h: size.height };
  }

  function onGripMove(e: React.PointerEvent<HTMLButtonElement>) {
    const d = dragRef.current;
    if (!d) return;
    const maxW = Math.max(MIN_W, window.innerWidth - 32);
    const maxH = Math.max(MIN_H, window.innerHeight - 32);
    setSize({
      width: Math.round(Math.min(maxW, Math.max(MIN_W, d.w + (d.x - e.clientX)))),
      height: Math.round(Math.min(maxH, Math.max(MIN_H, d.h + (d.y - e.clientY)))),
    });
  }

  function onGripUp(e: React.PointerEvent<HTMLButtonElement>) {
    if (!dragRef.current) return;
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {}
    persistSize(size);
  }

  const dot =
    state === "live"
      ? "bg-emerald-400"
      : state === "connecting"
        ? "animate-pulse bg-amber-400"
        : state === "error"
          ? "bg-red-400"
          : "bg-zinc-500";

  return (
    <div
      className="fixed right-4 bottom-4 z-40 flex flex-col overflow-hidden rounded-2xl border border-white/15 bg-black/90 shadow-2xl backdrop-blur-xl"
      style={{
        width: size.width,
        ...(collapsed ? {} : { height: size.height }),
      }}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-white/10 px-3 py-2">
        <MonitorPlay size={14} className="text-white/80" />
        <span className="text-[11px] font-semibold text-white">Live browser</span>
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
        <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-500" title={url}>
          {url || (state === "connecting" ? "waiting for a page…" : "—")}
        </span>
        <button
          onClick={() => {
            setState("connecting");
            setError("");
            setAttempt((n) => n + 1);
          }}
          title="Reconnect"
          className="rounded-full bg-white/10 p-1.5 text-white hover:bg-white/20"
        >
          <RotateCw size={12} />
        </button>
        <button
          onClick={toggleCollapsed}
          title={collapsed ? "Expand live view" : "Collapse live view"}
          className="rounded-full bg-white/10 p-1.5 text-white hover:bg-white/20"
        >
          {collapsed ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
        <button
          onClick={onClose}
          title="Close live view"
          className="rounded-full bg-white p-1.5 text-black hover:bg-zinc-200"
        >
          <X size={12} />
        </button>
      </div>

      {!collapsed && (
        <>
          <div className="relative grid min-h-0 flex-1 place-items-center bg-zinc-950">
            {frame ? (
              <img
                src={frame}
                alt="Live browser view"
                className="h-full w-full object-contain"
              />
            ) : (
              <div className="flex flex-col items-center gap-2 p-6 text-center">
                {state === "error" ? (
                  <p className="max-w-sm text-xs text-red-300">{error}</p>
                ) : (
                  <>
                    <Loader2 size={18} className="animate-spin text-white/70" />
                    <p className="text-xs text-zinc-500">
                      Waiting for the agent to open a page…
                    </p>
                  </>
                )}
              </div>
            )}
            {state === "ended" && (
              <div className="absolute inset-0 grid place-items-center bg-black/55">
                <p className="rounded-full bg-white/10 px-3 py-1 text-[11px] text-white">
                  Session ended
                </p>
              </div>
            )}
            {/* grip resize: sudut kiri-atas */}
            <button
              onPointerDown={onGripDown}
              onPointerMove={onGripMove}
              onPointerUp={onGripUp}
              onPointerCancel={onGripUp}
              title="Drag to resize"
              aria-label="Resize live view"
              className="absolute top-0 left-0 grid h-6 w-6 place-items-center rounded-br-lg bg-black/40 text-white/60 opacity-70 transition hover:bg-black/70 hover:text-white hover:opacity-100"
              style={{ cursor: "nwse-resize", touchAction: "none" }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M1 9L9 1M5 9L9 5" stroke="currentColor" strokeWidth="1.4" />
              </svg>
            </button>
          </div>
          <div className="flex shrink-0 items-center gap-2 border-t border-white/10 px-3 py-1.5 text-[10px] text-zinc-500">
            <span className="truncate">Read-only · drag the corner to resize</span>
            <span className="ml-auto shrink-0 font-mono">
              {size.width}×{size.height}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
