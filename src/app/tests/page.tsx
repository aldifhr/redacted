"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, CheckCircle2, Copy, FileText, FileUp, FlaskConical, Play, RotateCw, Trash2, XCircle } from "lucide-react";
import { rowsToCases, suggestFileName, type ImportedCase } from "@/lib/case-import";
import { readSpreadsheet } from "@/lib/spreadsheet";
import Stagger from "@/components/chat/Stagger";

type SpecInfo = { file: string; kb: number; updatedAt: number };
type SpecResult = { title: string; file: string; status: string; durationMs: number; error: string };
type RunSummary = { ok: boolean; passed: number; failed: number; skipped: number; durationMs: number; results: SpecResult[]; error?: string; lastFailed?: boolean; artifacts?: { kind: string; name: string; path: string }[] };
type RunLogEntry = { id: string; at: number; scope: string | null; passed: number; failed: number; skipped: number; durationMs: number; ok: boolean };
type TestCase = { id: string; area: string; type: string; title: string; expected: string; priority: string; severity: string; result?: { status: string; actual: string; executedAt: number } };

const RESULT_STATUSES = ["UNTESTED", "PASS", "FAIL", "BLOCKED", "SKIPPED"] as const;

function statusColor(status: string) {
  switch (status) {
    case "PASS": return "text-emerald-300";
    case "FAIL": return "text-red-300";
    case "BLOCKED": return "text-amber-300";
    case "SKIPPED": return "text-zinc-500";
    default: return "text-zinc-600";
  }
}

function fmtDate(ts: number) {
  if (!ts) return "-";
  try {
    return new Date(ts).toLocaleString("en-US", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  } catch {
    return "-";
  }
}

function timeAgo(ts: number) {
  if (!ts) return "-";
  const diff = Date.now() - ts;
  if (diff < 0) return "just now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return fmtDate(ts);
}

export const CHAT_PREFILL_KEY = "chat-prefill";

export default function TestsPage() {
  const router = useRouter();
  const [specs, setSpecs] = useState<SpecInfo[]>([]);
  const [lastRun, setLastRun] = useState<Record<string, RunSummary>>({});
  const [history, setHistory] = useState<RunLogEntry[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [viewFile, setViewFile] = useState<string | null>(null);
  const [viewContent, setViewContent] = useState("");
  const [viewCases, setViewCases] = useState<TestCase[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { status: string; actual: string }>>({});
  const [saving, setSaving] = useState(false);
  const [changes, setChanges] = useState<{ id: string; title: string; from: string; to: string }[]>([]);
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [confirmClearHistory, setConfirmClearHistory] = useState(false);
  const [imported, setImported] = useState<ImportedCase[] | null>(null);
  const [importName, setImportName] = useState("");
  const [importing, setImporting] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");

  function generateViaChat() {
    try {
      localStorage.setItem(
        CHAT_PREFILL_KEY,
        "Create a smoke test for https://www.saucedemo.com: log in with standard_user / secret_sauce, verify the inventory page, save the spec, and run it"
      );
    } catch {}
    router.push("/chat");
  }

  async function importFile(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setError("");
    try {
      const sheets = await readSpreadsheet(file);
      const merged: ImportedCase[] = [];
      for (const sheet of sheets) {
        const [headerRow, ...rows] = sheet.rows;
        if (!headerRow || !rows.length) continue;
        const headers = headerRow;
        try {
          const parsed = rowsToCases(headers, rows, {
            areaFallback: sheet.name,
            idPrefix: sheet.name.slice(0, 4).toUpperCase() || "TC",
          });
          merged.push(...parsed);
        } catch {
          // Sheet without recognizable columns — skipped, others still import.
        }
        if (merged.length >= 50) break;
      }
      if (!merged.length) throw new Error("No importable rows found in any sheet");
      setImported(merged.slice(0, 50));
      setImportName(suggestFileName(file.name));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to parse spreadsheet.");
      setImported(null);
    }
  }

  async function saveImport() {
    if (!imported?.length || !importName.trim()) return;
    setImporting(true);
    setError("");
    try {
      const res = await fetch("/api/tests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "import", file: importName.trim(), cases: imported }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Import failed.");
      setImported(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed.");
    } finally {
      setImporting(false);
    }
  }

  function copySpec() {
    if (!viewContent) return;
    navigator.clipboard?.writeText(viewContent).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {}
    );
  }

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/tests", { cache: "no-store" });
      const data = await res.json();
      if (Array.isArray(data.tests)) setSpecs(data.tests);
      if (data.lastRun) setLastRun(data.lastRun);
      if (Array.isArray(data.history)) setHistory(data.history);
    } catch {
      setError("Failed to load specs.");
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(refresh, 0);
    return () => clearTimeout(t);
  }, [refresh]);

  async function run(file?: string, lastFailed = false) {
    setRunning(file ?? "__all__");
    setError("");
    const prior = new Map<string, string>();
    const scopes = file ? [lastRun[file]] : Object.values(lastRun);
    for (const s of scopes) {
      for (const t of s?.results ?? []) if (!prior.has(t.title)) prior.set(t.title, t.status);
    }
    try {
      const res = await fetch("/api/tests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "run", file, lastFailed: lastFailed || undefined }),
      });
      const summary = (await res.json()) as RunSummary;
      if (summary.error && !summary.results.length) setError(summary.error);
      const transitions = summary.results
        .filter((t) => prior.has(t.title) && prior.get(t.title) !== t.status)
        .map((t) => ({ id: t.title, title: t.title, from: prior.get(t.title) ?? "?", to: t.status }));
      setChanges(transitions);
      await refresh();
    } catch {
      setError("Test run failed.");
    } finally {
      setRunning(null);
    }
  }

  async function view(file: string) {
    setError("");
    setViewCases(null);
    try {
      const res = await fetch("/api/tests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get", file }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setViewFile(file);
      setViewContent(data.content);
      setCopied(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to read spec.");
    }
  }

  async function cases(file: string) {
    setError("");
    setViewContent("");
    try {
      const res = await fetch("/api/tests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cases", file }),
      });
      const data = await res.json();
      setViewFile(file);
      const loaded: TestCase[] = Array.isArray(data.cases) ? data.cases : [];
      setViewCases(loaded);
      const initial: Record<string, { status: string; actual: string }> = {};
      for (const c of loaded) {
        initial[c.id] = { status: c.result?.status ?? "UNTESTED", actual: c.result?.actual ?? "" };
      }
      setDrafts(initial);
    } catch {
      setError("Failed to load test cases.");
    }
  }

  async function recordResults() {
    if (!viewFile || !viewCases) return;
    const changed = viewCases
      .map((c) => ({ id: c.id, ...drafts[c.id] }))
      .filter((r) => r.status && r.status !== "UNTESTED" && (
        r.status !== (viewCases.find((c) => c.id === r.id)?.result?.status ?? "UNTESTED") ||
        r.actual !== (viewCases.find((c) => c.id === r.id)?.result?.actual ?? "")
      ));
    if (!changed.length) {
      setError("No changes to save — set a status first.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/tests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "record", file: viewFile, results: changed }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to record results.");
      if (Array.isArray(data.changes) && data.changes.length) {
        setChanges(data.changes as { id: string; title: string; from: string; to: string }[]);
      }
      await cases(viewFile);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to record results.");
    } finally {
      setSaving(false);
    }
  }

  async function clearHistory() {
    setConfirmClearHistory(false);
    try {
      const res = await fetch("/api/tests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "clear-history" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to clear history.");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to clear history.");
    }
  }
  async function remove(file: string) {
    setPendingDelete(null);
    try {
      await fetch("/api/tests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", file }),
      });
      if (viewFile === file) {
        setViewFile(null);
        setViewContent("");
        setViewCases(null);
      }
      await refresh();
    } catch {
      setError("Failed to delete spec.");
    }
  }

  const visible = specs.filter((s) =>
    !query.trim() || s.file.toLowerCase().includes(query.trim().toLowerCase())
  );

  const grouped = useMemo(() => {
    const map = new Map<string, typeof visible>();
    for (const s of visible) {
      const g = s.file.includes("/") ? s.file.slice(0, s.file.indexOf("/")) : "general";
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(s);
    }
    return [...map.entries()];
  }, [visible]);

  const totals = specs.reduce(
    (acc, s) => {
      const r = lastRun[s.file];
      if (r) {
        acc.passed += r.passed;
        acc.failed += r.failed;
        acc.skipped += r.skipped;
      }
      return acc;
    },
    { passed: 0, failed: 0, skipped: 0 }
  );

  return (
    <main className="mesh-bg min-h-screen text-white">
      <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/chat" className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-300 hover:bg-white/10 hover:text-white">
            <ArrowLeft size={15} /> Chat
          </Link>
          <div className="ml-auto flex gap-2">
            <button onClick={refresh} className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-300 hover:bg-white/10">
              <RotateCw size={14} /> Refresh
            </button>
            <button onClick={() => importRef.current?.click()} className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-300 hover:bg-white/10">
              <FileUp size={14} /> Import XLSX/CSV
            </button>
            <input ref={importRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => { void importFile(e.target.files); e.currentTarget.value = ""; }} />
            <button
              onClick={() => run()}
              disabled={running !== null || !specs.length}
              className="inline-flex items-center gap-2 rounded-xl bg-white px-3 py-2 text-xs font-semibold text-black hover:bg-zinc-200 disabled:opacity-30"
            >
              <Play size={14} /> {running === "__all__" ? "Running…" : "Run all"}
            </button>
          </div>
        </div>

        {imported && (
          <div className="mt-6 rounded-2xl border border-emerald-300/25 bg-emerald-300/5 p-4">
            <Stagger>
              <p className="text-sm font-semibold text-white">
                {imported.length} case(s) parsed — review, name the file, save.
              </p>
            </Stagger>
            <div className="mt-1 max-h-40 overflow-auto rounded-xl bg-black/40 p-3 text-[11px] text-zinc-400">
              {imported.slice(0, 10).map((c) => (
                <p key={c.id} className="truncate">{c.id} — {c.title} ({c.steps.length} steps)</p>
              ))}
              {imported.length > 10 && <p className="text-zinc-600">…and {imported.length - 10} more</p>}
            </div>
            <div className="mt-3 flex gap-2">
              <input
                value={importName}
                onChange={(e) => setImportName(e.target.value)}
                placeholder="file-name.spec.ts"
                className="w-full rounded-xl border border-white/10 bg-black/50 px-3 py-2 text-xs text-white outline-none placeholder:text-zinc-600"
              />
              <button
                onClick={saveImport}
                disabled={importing || !importName.trim()}
                className="shrink-0 rounded-xl bg-white px-4 py-2 text-xs font-bold text-black hover:bg-zinc-200 disabled:opacity-30"
              >
                {importing ? "Saving…" : "Save cases"}
              </button>
              <button onClick={() => setImported(null)} className="shrink-0 rounded-xl border border-white/15 px-4 py-2 text-xs text-zinc-300 hover:bg-white/10">
                Cancel
              </button>
            </div>
          </div>
        )}

        <header className="mt-8 flex items-start gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-2xl bg-white text-black"><FlaskConical size={22} /></div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Tests</h1>
            <p className="mt-1 text-sm text-zinc-500">Saved Playwright specs, run results, and structured test cases.</p>
          </div>
        </header>

        {error && <p className="mt-4 rounded-xl border border-white/25 bg-white/8 px-4 py-3 text-sm text-white">{error}</p>}

        {changes.length > 0 && (
          <div className="mt-4 rounded-2xl border border-white/15 bg-white/5 p-4">
            <div className="flex items-center gap-2">
              <p className="text-xs font-semibold text-white">Status changes ({changes.length})</p>
              <button
                onClick={() => setChanges([])}
                className="ml-auto rounded-lg bg-white/8 px-2 py-1 text-[10px] text-zinc-400 hover:bg-white/15 hover:text-white"
              >
                Dismiss
              </button>
            </div>
            <div className="mt-2 flex flex-col gap-1">
              {changes.slice(0, 12).map((c, i) => (
                <p key={`${c.id}-${i}`} className="text-[11px] text-zinc-400">
                  <span className={c.from === "PASS" || c.from === "passed" ? "text-emerald-300" : "text-zinc-500"}>
                    {c.from.toUpperCase()}
                  </span>
                  <span className="mx-1 text-zinc-600">&#8594;</span>
                  <span className={c.to === "PASS" || c.to === "passed" ? "text-emerald-300" : "text-amber-300"}>
                    {c.to.toUpperCase()}
                  </span>
                  <span className="ml-2 text-zinc-500">{c.title}</span>
                </p>
              ))}
              {changes.length > 12 && <p className="text-[10px] text-zinc-600">+{changes.length - 12} more</p>}
            </div>
          </div>
        )}

        <div className="mt-6 grid grid-cols-3 gap-2">
          <div className="glass rounded-2xl p-4"><p className="text-2xl font-bold">{specs.length}</p><p className="text-[10px] uppercase tracking-widest text-zinc-500">Specs</p></div>
          <div className="glass rounded-2xl p-4"><p className="text-2xl font-bold text-emerald-300">{totals.passed}</p><p className="text-[10px] uppercase tracking-widest text-zinc-500">Passed</p></div>
          <div className="glass rounded-2xl p-4"><p className="text-2xl font-bold text-amber-300">{totals.failed}</p><p className="text-[10px] uppercase tracking-widest text-zinc-500">Failed</p></div>
        </div>

        <div className="mt-6 overflow-hidden rounded-2xl border border-white/10">
          {specs.length === 0 ? (
            <div className="p-12 text-center">
              <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-white/8"><FlaskConical size={22} className="text-zinc-400" /></div>
              <p className="mt-3 text-sm font-medium text-white">No specs yet</p>
              <p className="mx-auto mt-1 max-w-sm text-xs text-zinc-500">Ask the agent to explore a site, save a Playwright spec, and run it — all from chat.</p>
              <button onClick={generateViaChat} className="mt-4 inline-flex items-center gap-2 rounded-xl bg-white px-4 py-2 text-xs font-semibold text-black hover:bg-zinc-200">
                <Play size={13} /> Generate via chat
              </button>
            </div>
          ) : (
              <>
              <div className="border-b border-white/10 bg-black/30 px-4 py-2.5">
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search specs…"
                  className="w-full bg-transparent text-xs text-white outline-none placeholder:text-zinc-600"
                />
              </div>
              {visible.length === 0 ? (
                <div className="p-8 text-center text-xs text-zinc-500">No specs match &ldquo;{query}&rdquo;.</div>
              ) : (
                <>
                {grouped.map(([group, items]) => (
                  <div key={group}>
                    <div className="border-b border-white/10 bg-black/40 px-4 py-2 text-[10px] font-semibold uppercase tracking-widest text-zinc-400">
                      {group} • {items.length} spec(s)
                    </div>
                    {items.map((s) => {
              const r = lastRun[s.file];
              const shortName = s.file.includes("/") ? s.file.slice(s.file.indexOf("/") + 1) : s.file;
              return (
                <div key={s.file} className="border-b border-white/8 px-4 py-3 last:border-b-0 hover:bg-white/5">
                  <div className="flex flex-wrap items-center gap-3">
                    {r ? (
                      r.ok ? <CheckCircle2 size={16} className="shrink-0 text-emerald-300" /> : <XCircle size={16} className="shrink-0 text-amber-300" />
                    ) : (
                      <FileText size={16} className="shrink-0 text-zinc-600" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-white" title={s.file}>{shortName}</p>
                      <p className="text-[11px] text-zinc-500">
                        {s.kb} KB • {fmtDate(s.updatedAt)}
                        {r && ` • ${r.passed} passed, ${r.failed} failed, ${r.skipped} skipped in ${r.durationMs}ms`}
                      </p>
                    </div>
                    <div className="flex gap-1.5">
                      <button onClick={() => run(s.file)} disabled={running !== null} className="rounded-lg bg-white/8 px-2.5 py-1.5 text-[11px] text-zinc-200 hover:bg-white/15 disabled:opacity-30">
                        {running === s.file ? "Running." : "Run"}
                      </button>
                      {!!r?.failed && (
                        <button
                          onClick={() => run(s.file, true)}
                          disabled={running !== null}
                          title="Playwright --last-failed: rerun only the tests that failed last time"
                          className="rounded-lg bg-amber-300/15 px-2.5 py-1.5 text-[11px] text-amber-200 hover:bg-amber-300/25 disabled:opacity-30"
                        >
                          {running === s.file ? "Running." : "Rerun failed"}
                        </button>
                      )}
                      <button onClick={() => view(s.file)} className="rounded-lg bg-white/8 px-2.5 py-1.5 text-[11px] text-zinc-200 hover:bg-white/15">View</button>
                      <button onClick={() => cases(s.file)} className="rounded-lg bg-white/8 px-2.5 py-1.5 text-[11px] text-zinc-200 hover:bg-white/15">Cases</button>
                      <button onClick={() => setPendingDelete(s.file)} title="Delete spec" className="rounded-lg bg-white/8 px-2.5 py-1.5 text-[11px] text-zinc-400 hover:bg-white/15 hover:text-white">
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                  {!!r?.results.length && (
                    <div className="mt-2 flex flex-col gap-1 border-l border-white/15 pl-3">
                      {r.results.map((t, i) => (
                        <p key={`${t.title}-${i}`} className="text-[11px] text-zinc-400">
                          <span className={t.status === "passed" ? "text-emerald-300" : t.status === "skipped" ? "text-zinc-500" : "text-amber-300"}>
                            {t.status.toUpperCase()}
                          </span>{" "}
                          {t.title} <span className="text-zinc-600">({t.durationMs}ms)</span>
                          {t.error && <span className="block truncate text-zinc-500">{t.error.split("\n")[0]}</span>}
                        </p>
                      ))}
                    </div>
                  )}
                  {!!r?.artifacts?.length && (
                    <div className="mt-2 flex flex-wrap items-center gap-2 border-l border-white/15 pl-3">
                      <span className="text-[10px] uppercase tracking-widest text-zinc-600">Trace / video</span>
                      {r.artifacts.slice(0, 8).map((a) => (
                        <a
                          key={a.path}
                          href={`/api/tests/artifact?path=${encodeURIComponent(a.path)}`}
                          target="_blank"
                          rel="noreferrer"
                          title={`${a.kind}: ${a.path}${a.kind === "trace" ? " (open with: npx playwright show-trace <file>)" : ""}`}
                          className="rounded-lg bg-white/8 px-2 py-1 text-[10px] text-zinc-300 hover:bg-white/15 hover:text-white"
                        >
                          {a.kind}
                        </a>
                      ))}
                    </div>
                  )}
                </div>
                      );
                    })}
                    </div>
                  ))}
                  </>
                  )}
              </>
          )}
        </div>

        {viewFile && (
          <div className="mt-6 overflow-hidden rounded-2xl border border-white/10">
            <div className="flex items-center gap-2 border-b border-white/10 bg-black/30 px-4 py-3">
              <FileText size={14} className="text-white" />
              <p className="truncate text-xs font-semibold text-white">{viewFile}</p>
              {viewContent && (
                <button onClick={copySpec} className="inline-flex items-center gap-1 rounded-lg bg-white/8 px-2 py-1 text-[11px] text-zinc-300 hover:bg-white/15 hover:text-white">
                  <Copy size={11} /> {copied ? "Copied" : "Copy"}
                </button>
              )}
              <button onClick={() => { setViewFile(null); setViewContent(""); setViewCases(null); }} className="ml-auto text-[11px] text-zinc-500 hover:text-white">Close</button>
            </div>
            {viewContent ? (
              <pre className="max-h-[50vh] overflow-auto bg-black/50 p-4 text-[11px] leading-relaxed whitespace-pre-wrap text-zinc-300">{viewContent}</pre>
            ) : viewCases ? (
              viewCases.length === 0 ? (
                <p className="p-6 text-center text-xs text-zinc-500">No structured cases saved for this spec.</p>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-2 border-b border-white/10 bg-black/30 px-4 py-2.5 text-[11px]">
                    {RESULT_STATUSES.filter((s) => s !== "UNTESTED").map((s) => {
                      const n = viewCases.filter((c) => (c.result?.status ?? "UNTESTED") === s).length;
                      return <span key={s} className={`${statusColor(s)}`}>{s}: {n}</span>;
                    })}
                    <span className="text-zinc-600">
                      UNTESTED: {viewCases.filter((c) => (c.result?.status ?? "UNTESTED") === "UNTESTED").length}
                    </span>
                    <button
                      onClick={recordResults}
                      disabled={saving}
                      className="ml-auto rounded-lg bg-white px-3 py-1.5 text-[11px] font-bold text-black hover:bg-zinc-200 disabled:opacity-30"
                    >
                      {saving ? "Saving…" : "Save results"}
                    </button>
                  </div>
                  <div className="overflow-x-auto">
                  <table className="w-full text-left text-[11px]">
                    <thead>
                      <tr className="border-b border-white/10 text-zinc-500">
                        <th className="px-3 py-2 font-medium">ID</th>
                        <th className="px-3 py-2 font-medium">Title</th>
                        <th className="px-3 py-2 font-medium">Priority</th>
                        <th className="px-3 py-2 font-medium">Status</th>
                        <th className="px-3 py-2 font-medium">Actual result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {viewCases.map((c) => (
                        <tr key={c.id} className="border-b border-white/5 text-zinc-300 last:border-b-0">
                          <td className="px-3 py-2 whitespace-nowrap">{c.id}</td>
                          <td className="px-3 py-2" title={c.expected}>{c.title}</td>
                          <td className="px-3 py-2 whitespace-nowrap">{c.priority}</td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            <select
                              value={drafts[c.id]?.status ?? "UNTESTED"}
                              onChange={(e) => setDrafts((d) => ({ ...d, [c.id]: { status: e.target.value, actual: d[c.id]?.actual ?? "" } }))}
                              className={`cursor-pointer rounded-lg border border-white/10 bg-black/50 px-2 py-1 text-[11px] outline-none ${statusColor(drafts[c.id]?.status ?? "UNTESTED")}`}
                            >
                              {RESULT_STATUSES.map((s) => (
                                <option key={s} value={s}>{s}</option>
                              ))}
                            </select>
                          </td>
                          <td className="min-w-40 px-3 py-2">
                            <input
                              value={drafts[c.id]?.actual ?? ""}
                              onChange={(e) => setDrafts((d) => ({ ...d, [c.id]: { status: d[c.id]?.status ?? "UNTESTED", actual: e.target.value } }))}
                              placeholder="Actual result…"
                              maxLength={500}
                              className="w-full rounded-lg border border-white/10 bg-black/50 px-2 py-1 text-[11px] text-zinc-200 outline-none placeholder:text-zinc-600"
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                </>
              )
            ) : null}
          </div>
        )}

        {pendingDelete && (
          <div
            className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm"
            onClick={() => setPendingDelete(null)}
          >
            <div
              className="glass w-full max-w-sm rounded-2xl p-5 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-2.5">
                <span className="grid h-9 w-9 place-items-center rounded-xl bg-red-400/15">
                  <Trash2 size={16} className="text-red-300" />
                </span>
                <div>
                  <p className="text-sm font-bold text-white">Delete spec?</p>
                  <p className="truncate text-[11px] text-zinc-500">{pendingDelete}</p>
                </div>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-zinc-400">
                The spec file, its test cases, and recorded results will be permanently deleted.
              </p>
              <div className="mt-4 flex gap-2">
                <button
                  onClick={() => setPendingDelete(null)}
                  className="flex-1 rounded-xl border border-white/15 px-4 py-2 text-xs font-semibold text-zinc-300 transition hover:bg-white/10 hover:text-white"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void remove(pendingDelete)}
                  className="flex-1 rounded-xl bg-red-400 px-4 py-2 text-xs font-bold text-black transition hover:bg-red-300 active:scale-[0.98]"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        )}
        {confirmClearHistory && (
          <div
            className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm"
            onClick={() => setConfirmClearHistory(false)}
          >
            <div
              className="glass w-full max-w-sm rounded-2xl p-5 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <p className="text-sm font-bold text-white">Clear run history?</p>
              <p className="mt-1 text-xs leading-relaxed text-zinc-400">
                All {history.length} recorded run(s) will be removed. Saved specs, cases, and results are kept.
              </p>
              <div className="mt-4 flex gap-2">
                <button
                  onClick={() => setConfirmClearHistory(false)}
                  className="flex-1 rounded-xl border border-white/15 px-4 py-2 text-xs font-semibold text-zinc-300 transition hover:bg-white/10 hover:text-white"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void clearHistory()}
                  className="flex-1 rounded-xl bg-white px-4 py-2 text-xs font-bold text-black transition hover:bg-zinc-200 active:scale-[0.98]"
                >
                  Clear
                </button>
              </div>
            </div>
          </div>
        )}

        {history.length > 0 && (
          <div className="mt-6">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-white">Run history</h2>
              <button
                onClick={() => setConfirmClearHistory(true)}
                className="ml-auto rounded-lg bg-white/8 px-2.5 py-1.5 text-[11px] text-zinc-400 hover:bg-white/15 hover:text-white"
              >
                Clear history
              </button>
            </div>
            <div className="mt-2 overflow-hidden rounded-2xl border border-white/10">
              {history.slice().reverse().slice(0, 20).map((h) => (
                <div key={h.id} className="flex flex-wrap items-center gap-3 border-b border-white/8 px-4 py-2.5 text-[11px] last:border-b-0">
                  {h.ok ? <CheckCircle2 size={14} className="text-emerald-300" /> : <XCircle size={14} className="text-amber-300" />}
                  <span className="text-zinc-300">{h.scope ?? "all"}</span>
                  <span className="text-zinc-500" title={fmtDate(h.at)}>{timeAgo(h.at)}</span>
                  <span className="ml-auto text-zinc-500">{h.passed} passed • {h.failed} failed • {h.skipped} skipped • {h.durationMs}ms</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
