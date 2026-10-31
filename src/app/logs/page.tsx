"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { ArrowLeft, CheckCircle2, ClipboardList, RotateCw, Trash2, XCircle } from "lucide-react";

type ToolLog = {
  id: string;
  at: number;
  tool: string;
  status: "success" | "error";
  durationMs: number;
  input: unknown;
  output?: unknown;
  error?: string;
  runId?: string;
};

function display(value: unknown) {
  if (value === undefined) return "-";
  try {
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export default function LogsPage() {
  const [filter, setFilter] = useState("all");
  const [error, setError] = useState("");
  const queryClient = useQueryClient();

  const logsQuery = useQuery({
    queryKey: ["logs"],
    queryFn: async (): Promise<ToolLog[]> => {
      const response = await fetch("/api/logs", { cache: "no-store" });
      const data = await response.json();
      return Array.isArray(data.logs) ? (data.logs as ToolLog[]) : [];
    },
    // Tool log bisa bertambah dari run lain — polling 5s seperti sebelumnya.
    refetchInterval: 5_000,
  });

  const clearMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/logs", { method: "DELETE" });
      if (!response.ok) throw new Error("Failed to clear logs");
    },
    onSuccess: () => {
      setError("");
      void queryClient.invalidateQueries({ queryKey: ["logs"] });
    },
    onError: (e) => {
      setError(e instanceof Error ? e.message : "Failed to clear logs");
    },
  });

  const logs = useMemo(() => logsQuery.data ?? [], [logsQuery.data]);

  function clear() {
    if (!window.confirm("Delete all tool logs?")) return;
    setError("");
    clearMutation.mutate();
  }

  const visible = useMemo(
    () => logs.slice().reverse().filter((log) => filter === "all" || log.tool === filter),
    [logs, filter]
  );
  const tools = [...new Set(logs.map((log) => log.tool))].sort();
  const failures = logs.filter((log) => log.status === "error").length;

  return (
    <main className="mesh-bg min-h-screen text-white">
      <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/chat" className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-300 hover:bg-white/10 hover:text-white">
            <ArrowLeft size={15} /> Chat
          </Link>
          <div className="ml-auto flex gap-2">
            <button onClick={() => void logsQuery.refetch()} disabled={logsQuery.isFetching} className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-300 hover:bg-white/10 disabled:opacity-30">
              <RotateCw size={14} className={logsQuery.isFetching ? "animate-spin" : ""} /> Refresh
            </button>
            <button onClick={clear} disabled={clearMutation.isPending || !logs.length} className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-300 hover:bg-white/10 disabled:opacity-30">
              <Trash2 size={14} /> Clear
            </button>
          </div>
        </div>

        <header className="mt-8 flex items-start gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-2xl bg-white text-black"><ClipboardList size={22} /></div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Tool Logs</h1>
             <p className="mt-1 text-sm text-zinc-500">Audit browser actions, shell commands, and file reads.</p>
          </div>
        </header>

        {error && <p className="mt-4 rounded-xl border border-red-400/20 bg-red-400/5 px-4 py-3 text-sm text-red-200">{error}</p>}

        <div className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-3">
          <div className="glass rounded-2xl p-4"><p className="text-2xl font-bold">{logs.length}</p><p className="text-[10px] uppercase tracking-widest text-zinc-500">Total calls</p></div>
          <div className="glass rounded-2xl p-4"><p className="text-2xl font-bold">{tools.length}</p><p className="text-[10px] uppercase tracking-widest text-zinc-500">Tools</p></div>
          <div className="glass col-span-2 rounded-2xl p-4 sm:col-span-1"><p className="text-2xl font-bold">{failures}</p><p className="text-[10px] uppercase tracking-widest text-zinc-500">Errors</p></div>
        </div>

        <div className="mt-6 flex flex-wrap gap-2">
           <button onClick={() => setFilter("all")} className={`rounded-full px-3 py-1.5 text-xs ${filter === "all" ? "bg-white text-black" : "bg-white/8 text-zinc-400"}`}>All</button>
          {tools.map((tool) => <button key={tool} onClick={() => setFilter(tool)} className={`rounded-full px-3 py-1.5 text-xs ${filter === tool ? "bg-white text-black" : "bg-white/8 text-zinc-400"}`}>{tool}</button>)}
        </div>

        <div className="mt-3 overflow-hidden rounded-2xl border border-white/10">
           {visible.length === 0 ? <div className="p-12 text-center text-sm text-zinc-500">No tool logs yet.</div> : visible.map((log) => (
            <details key={log.id} className="border-b border-white/8 last:border-b-0">
              <summary className="flex cursor-pointer list-none flex-wrap items-center gap-3 px-4 py-3 hover:bg-white/5">
                {log.status === "success" ? <CheckCircle2 size={16} className="text-zinc-300" /> : <XCircle size={16} className="text-white" />}
                <code className="text-xs text-zinc-200">{log.tool}</code>
                 <span className="text-[11px] text-zinc-500">{new Date(log.at).toLocaleString("en-US")}</span>
                <span className="ml-auto text-[11px] text-zinc-500">{log.durationMs}ms</span>
              </summary>
              <div className="grid gap-3 bg-black/30 px-4 pb-4 pt-1 md:grid-cols-2">
                <div><p className="mb-1 text-[10px] uppercase tracking-widest text-zinc-600">Input</p><pre className="max-h-56 overflow-auto rounded-xl bg-black/50 p-3 text-[11px] whitespace-pre-wrap text-zinc-400">{display(log.input)}</pre></div>
                <div><p className="mb-1 text-[10px] uppercase tracking-widest text-zinc-600">Output / Error</p><pre className="max-h-56 overflow-auto rounded-xl bg-black/50 p-3 text-[11px] whitespace-pre-wrap text-zinc-400">{display(log.error || log.output)}</pre></div>
              </div>
            </details>
          ))}
        </div>
      </div>
    </main>
  );
}
