"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CheckCircle2, CircleAlert, Info, X } from "lucide-react";
import { cssMs } from "@/lib/css-duration";
import { cn } from "@/lib/utils";

export type ToastVariant = "success" | "error" | "info";

export type ToastInput = {
  title: string;
  description?: string;
  variant?: ToastVariant;
  duration?: number;
};

type ToastItem = Required<Pick<ToastInput, "title">> &
  Pick<ToastInput, "description"> & {
    id: number;
    variant: ToastVariant;
    duration: number;
  };

type ToastContextValue = {
  toast: (input: ToastInput) => number;
  success: (title: string, description?: string) => number;
  error: (title: string, description?: string) => number;
  info: (title: string, description?: string) => number;
  dismiss: (id: number) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

const VARIANT_STYLE: Record<
  ToastVariant,
  { icon: typeof Info; bar: string; iconClass: string }
> = {
  success: {
    icon: CheckCircle2,
    bar: "bg-white",
    iconClass: "text-white",
  },
  error: {
    icon: CircleAlert,
    bar: "bg-red-500",
    iconClass: "text-red-200",
  },
  info: {
    icon: Info,
    bar: "bg-zinc-500",
    iconClass: "text-zinc-300",
  },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idRef = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (input: ToastInput) => {
      idRef.current += 1;
      const id = idRef.current;
      const item: ToastItem = {
        id,
        title: input.title,
        description: input.description,
        variant: input.variant ?? "info",
        duration: input.duration ?? 4000,
      };
      setToasts((prev) => {
        const next = [...prev, item].slice(-4);
        const kept = new Set(next.map((t) => t.id));
        // Evicted toasts must not keep a live timer that fires later.
        for (const [id, timer] of timers.current) {
          if (!kept.has(id)) {
            clearTimeout(timer);
            timers.current.delete(id);
          }
        }
        return next;
      });
      if (item.duration > 0) {
        const timer = setTimeout(() => dismiss(id), item.duration);
        timers.current.set(id, timer);
      }
      return id;
    },
    [dismiss]
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      toast: push,
      success: (title, description) =>
        push({ title, description, variant: "success" }),
      error: (title, description) =>
        push({ title, description, variant: "error" }),
      info: (title, description) => push({ title, description, variant: "info" }),
      dismiss,
    }),
    [push, dismiss]
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <Toaster toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast harus dipakai di dalam <ToastProvider>");
  return ctx;
}

function ToastCard({
  toast,
  onDismiss,
}: {
  toast: ToastItem;
  onDismiss: (id: number) => void;
}) {
  const t = toast;
  const meta = VARIANT_STYLE[t.variant];
  const Icon = meta.icon;
  const ref = useRef<HTMLDivElement>(null);

  // transitions-dev 22-toast: pure CSS. Mount without .is-open, rAF adds it
  // (slow open clock); dismiss swaps it off and the parent removes us after
  // the fast close clock (--toast-close).
  useEffect(() => {
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => ref.current?.classList.add("is-open"))
    );
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      ref={ref}
      data-toast-id={t.id}
      className={cn(
        "t-toast pointer-events-auto relative flex items-start gap-3 overflow-hidden rounded-2xl border px-4 py-3 shadow-2xl backdrop-blur-xl",
        t.variant === "error"
          ? "border-white/25 bg-zinc-950/95"
          : "border-white/10 bg-zinc-950/90"
      )}
    >
      <span
        className={cn(
          "absolute top-0 left-0 h-full w-1",
          meta.bar
        )}
      />
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-white/10">
        <Icon size={16} className={meta.iconClass} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] leading-snug font-semibold text-white">
          {t.title}
        </p>
        {t.description && (
          <p className="mt-0.5 line-clamp-3 text-xs leading-relaxed text-zinc-400">
            {t.description}
          </p>
        )}
      </div>
      <button
        onClick={() => onDismiss(t.id)}
        aria-label="Tutup notifikasi"
        className="shrink-0 rounded-lg p-1 text-zinc-500 transition hover:bg-white/10 hover:text-white"
      >
        <X size={14} />
      </button>
    </div>
  );
}

function Toaster({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}) {
  const [leaving, setLeaving] = useState<ReadonlySet<number>>(new Set());
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const timersMap = timers.current;
    return () => {
      for (const timer of timersMap.values()) clearTimeout(timer);
    };
  }, []);

  function handleDismiss(id: number) {
    if (leaving.has(id)) return;
    setLeaving((prev) => new Set(prev).add(id));
    document
      .querySelector(`[data-toast-id="${id}"]`)
      ?.classList.remove("is-open");
    const closeMs = cssMs("--toast-close", 250);
    const existing = timers.current.get(id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      timers.current.delete(id);
      setLeaving((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      onDismiss(id);
    }, closeMs);
    timers.current.set(id, timer);
  }

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed right-4 bottom-4 z-[100] flex w-[calc(100vw-2rem)] max-w-sm flex-col gap-2"
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={handleDismiss} />
      ))}
    </div>
  );
}
