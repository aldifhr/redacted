"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Download, ExternalLink, Loader2, Pause, Play, Search, ShieldCheck, Trash2, Sparkles } from "lucide-react";

import { loadSessions } from "@/lib/store";

type Skill = { id: string; name: string; slug: string; source: string; installs: number; url: string; installUrl?: string | null };
type Installed = { name: string; disabled: boolean };

const displayId = (name: string) => name.replaceAll("--", "/");

// Sessions whose assistant messages loaded a given skill id.
function chatsUsing(skillId: string): number {
  try {
    return loadSessions().filter((s) =>
      s.messages.some(
        (m) => Array.isArray(m.skills) && m.skills.some((id) => id === skillId || displayId(id) === skillId)
      )
    ).length;
  } catch {
    return 0;
  }
}

export default function SkillsPage() {
  const [query, setQuery] = useState("");
  const [skills, setSkills] = useState<Skill[]>([]);
  const [installed, setInstalled] = useState<Installed[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async (search: string) => {
    try {
      const response = await fetch(`/api/skills?q=${encodeURIComponent(search)}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to load skills");
      setSkills(data.skills ?? []);
      setInstalled(data.installed ?? []);
      setError("");
    } catch (value) {
      setError(value instanceof Error ? value.message : "Failed to load skills");
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => { void load(""); }, 0);
    return () => clearTimeout(timer);
  }, [load]);

  async function toggle(skill: Skill) {
    setBusy(skill.id);
    try {
      const isInstalled = installed.some((entry) => displayId(entry.name) === skill.id);
      const response = await fetch("/api/skills", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: isInstalled ? "remove" : "install", id: skill.id }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Skill operation failed");
      await load(query);
    } catch (value) {
      setError(value instanceof Error ? value.message : "Skill operation failed");
    } finally {
      setBusy("");
    }
  }

  async function setEnabled(id: string, disabled: boolean) {
    setBusy(id);
    try {
      const response = await fetch("/api/skills", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: disabled ? "disable" : "enable", id }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Skill operation failed");
      await load(query);
    } catch (value) {
      setError(value instanceof Error ? value.message : "Skill operation failed");
    } finally {
      setBusy("");
    }
  }

  return <main className="mesh-bg min-h-screen text-white"><div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
    <Link href="/chat" className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-300 hover:bg-white/10 hover:text-white"><ArrowLeft size={15} /> Back to chat</Link>
    <header className="mt-8 flex items-start gap-3"><div className="grid h-11 w-11 place-items-center rounded-2xl bg-white text-black"><Sparkles size={22} /></div><div><h1 className="text-2xl font-bold tracking-tight">Agent Skills</h1><p className="mt-1 text-sm text-zinc-500">Discover procedural knowledge from skills.sh and make it available to FarayAgent.</p></div></header>
    <form onSubmit={(event) => { event.preventDefault(); void load(query); }} className="mt-6 flex gap-2"><div className="relative flex-1"><Search size={16} className="absolute top-1/2 left-3 -translate-y-1/2 text-zinc-600" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search skills…" className="w-full rounded-xl border border-white/10 bg-white/5 py-3 pr-3 pl-9 text-sm text-white outline-none placeholder:text-zinc-600 focus:border-white/30" /></div><button className="rounded-xl bg-white px-4 text-sm font-semibold text-black hover:bg-zinc-200">Search</button></form>
    {error && <p className="mt-4 rounded-xl border border-amber-300/20 bg-amber-300/5 px-4 py-3 text-sm text-amber-200">{error}</p>}
    {installed.length > 0 && (
      <section className="mt-8">
        <h2 className="text-sm font-semibold text-white">Installed ({installed.filter((s) => !s.disabled).length} active)</h2>
        <div className="mt-3 flex flex-col gap-2">
          {installed.map((entry) => {
            const id = displayId(entry.name);
            return (
              <div key={entry.name} className={`flex items-center gap-3 rounded-2xl border px-4 py-3 ${entry.disabled ? "border-white/5 opacity-60" : "border-white/10 bg-white/5"}`}>
                <Sparkles size={15} className="shrink-0 text-zinc-400" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-white">{id}</p>
                  <p className="text-[11px] text-zinc-500">
                    {entry.disabled ? "Disabled — not loaded into the prompt" : `Loaded into ${chatsUsing(id)} chat(s)`}
                  </p>
                </div>
                <button
                  onClick={() => void setEnabled(id, !entry.disabled)}
                  disabled={busy === id}
                  title={entry.disabled ? "Enable skill" : "Disable skill"}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-white/8 px-3 py-2 text-xs font-semibold text-zinc-200 hover:bg-white/15 disabled:opacity-30"
                >
                  {busy === id ? <Loader2 size={13} className="animate-spin" /> : entry.disabled ? <Play size={13} /> : <Pause size={13} />}
                  {entry.disabled ? "Enable" : "Disable"}
                </button>
                <button
                  onClick={() => void toggle({ id, name: "", slug: "", source: "", installs: 0, url: "" })}
                  disabled={busy === id}
                  title="Remove skill"
                  className="rounded-lg p-2 text-zinc-500 hover:bg-white/10 hover:text-white disabled:opacity-30"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })}
        </div>
      </section>
    )}
    <h2 className="mt-8 text-sm font-semibold text-white">Discover</h2>
    <div className="mt-6 grid gap-3 sm:grid-cols-2">{skills.map((skill) => { const active = installed.some((entry) => displayId(entry.name) === skill.id); return <article key={skill.id} className="rounded-2xl border border-white/10 bg-white/5 p-5 transition hover:border-white/25 hover:bg-white/8"><div className="flex items-start gap-3"><div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/10"><Sparkles size={16} /></div><div className="min-w-0 flex-1"><h2 className="truncate font-semibold">{skill.name}</h2><p className="truncate text-xs text-zinc-500">{skill.source}</p></div><span className="text-[10px] text-zinc-500">{skill.installs.toLocaleString()} installs</span></div><div className="mt-4 flex items-center gap-2"><span className="inline-flex items-center gap-1 text-[10px] text-zinc-500"><ShieldCheck size={12} /> Review source before enabling</span><a href={skill.url} target="_blank" rel="noreferrer" className="ml-auto rounded-lg p-2 text-zinc-500 hover:bg-white/10 hover:text-white" title="Open on skills.sh"><ExternalLink size={14} /></a><button onClick={() => void toggle(skill)} disabled={busy === skill.id} className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold ${active ? "border border-white/15 bg-white/5 text-zinc-300" : "bg-white text-black hover:bg-zinc-200"}`}>{busy === skill.id ? <Loader2 size={13} className="animate-spin" /> : active ? <Trash2 size={13} /> : <Download size={13} />}{active ? "Remove" : "Install"}</button></div></article>; })}</div>
    {!skills.length && !error && <div className="py-16 text-center text-sm text-zinc-500">No skills found.</div>}
    <p className="mt-8 text-xs leading-relaxed text-zinc-600">Installed skills are stored locally in <code>.skills/</code>. They provide instructions only and do not grant new tools or permissions.</p>
  </div></main>;
}
