"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowLeft, Brain, Loader2, Plus, Sparkles, Trash2 } from "lucide-react";
import { useToast } from "@/components/ui/toast";
import { loadSessions, loadSettings } from "@/lib/store";

export default function MemoryPage() {
  const [input, setInput] = useState("");
  const { success, error: showError } = useToast();
  const queryClient = useQueryClient();

  const factsQuery = useQuery({
    queryKey: ["memory"],
    queryFn: async (): Promise<string[]> => {
      const r = await fetch("/api/memory");
      const d = await r.json();
      return Array.isArray(d.facts) ? (d.facts as string[]) : [];
    },
    // MEMORY.md bisa berubah dari tab/sesi lain — polling 5s seperti sebelumnya.
    refetchInterval: 5_000,
  });
  const facts = factsQuery.data ?? [];

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["memory"] });
  };

  const saveMutation = useMutation({
    mutationFn: async (fact: string) => {
      const r = await fetch("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", fact }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Failed to save");
    },
    onSuccess: (_data, fact) => {
      setInput("");
      success("Fact saved", fact.slice(0, 40));
      invalidate();
    },
    onError: (e) => {
      showError("Error", e instanceof Error ? e.message : "Failed to save");
    },
  });

  const consolidateMutation = useMutation({
    mutationFn: async () => {
      const settings = loadSettings();
      const apiKey = settings.keys[settings.provider] ?? "";
      if (!apiKey.trim()) throw new Error("Add an API key in /settings first");
      const messages = loadSessions()
        .flatMap((s) => [...s.messages].reverse())
        .filter((m) => m.content.trim())
        .slice(0, 30)
        .reverse()
        .map((m) => ({
          role: m.role,
          content: m.content.split("\n\nAttached files:\n")[0].slice(0, 2000),
        }));
      if (!messages.length) throw new Error("No chat history to consolidate yet");
      const r = await fetch("/api/memory/consolidate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: settings.provider,
          model: settings.model,
          apiKey,
          baseUrl: settings.baseUrls[settings.provider] ?? "",
          messages,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Consolidation failed");
      return (d.saved ?? []) as unknown[];
    },
    onSuccess: (saved) => {
      success(
        "Memory consolidated",
        saved.length ? `${saved.length} new fact(s) saved` : "Nothing new worth remembering"
      );
      invalidate();
    },
    onError: (e) => {
      showError("Error", e instanceof Error ? e.message : "Consolidation failed");
    },
  });

  const forgetMutation = useMutation({
    // Send the whole fact so the server removes exactly this line; a 4-word
    // prefix could delete several unrelated facts that share those words.
    mutationFn: async (query: string) => {
      const r = await fetch("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "forget", query }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Failed to delete");
    },
    onSuccess: () => {
      success("Fact deleted", "Memory updated");
      invalidate();
    },
    onError: (e) => {
      showError("Error", e instanceof Error ? e.message : "Failed to delete");
    },
  });

  function save() {
    const fact = input.trim();
    if (!fact || saveMutation.isPending) return;
    saveMutation.mutate(fact);
  }

  function consolidate() {
    consolidateMutation.mutate();
  }

  function forget(fact: string) {
    forgetMutation.mutate(fact.trim());
  }

  return (
    <div className="mesh-bg min-h-screen text-white">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6"
      >
        <Link
          href="/chat"
          className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-300 transition hover:bg-white/10 hover:text-white"
        >
          <ArrowLeft size={15} />
        </Link>

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="mt-6 flex items-center gap-3"
        >
          <div className="grid h-11 w-11 place-items-center rounded-2xl bg-white shadow-lg shadow-white/10">
            <Brain size={22} className="text-black" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight">Memory</h1>
            <p className="text-xs text-zinc-500">
               FarayAgent long-term memory • stored in MEMORY.md ({facts.length}/100)
            </p>
          </div>
          <button
            onClick={consolidate}
            disabled={consolidateMutation.isPending}
            title="Extract durable facts from recent chats"
            className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-white px-3 py-2 text-xs font-bold text-black transition hover:bg-zinc-200 active:scale-[0.98] disabled:opacity-30"
          >
            {consolidateMutation.isPending ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
            {consolidateMutation.isPending ? "Reading…" : "Consolidate"}
          </button>
        </motion.div>

        <motion.form
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
          className="mt-6 flex gap-2"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
             placeholder="Add a fact… e.g. User prefers table-based answers"
            className="flex-1 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white outline-none placeholder:text-zinc-600 focus:border-white/40"
          />
          <button
            disabled={saveMutation.isPending || !input.trim()}
            className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white text-black hover:bg-zinc-200 disabled:opacity-30"
          >
            {saveMutation.isPending ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
          </button>
        </motion.form>

        <motion.div
          layout
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="mt-4 flex flex-col gap-2"
        >
          <AnimatePresence>
            {facts.length === 0 && (
              <motion.div
                key="empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="grid place-items-center rounded-2xl border border-dashed border-white/15 py-14 text-center"
              >
                <Brain size={26} className="text-zinc-700" />
                <p className="mt-3 text-sm font-medium text-zinc-400">No memories yet</p>
                <p className="mt-1 max-w-60 text-xs text-zinc-600">
                   FarayAgent remembers important facts from chat automatically — or add one manually above
                </p>
              </motion.div>
            )}
            {facts.map((f, i) => (
              <motion.div
                key={`${i}-${f.slice(0, 20)}`}
                layout
                initial={{ opacity: 0, x: -12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -12 }}
                className="glass group flex items-center gap-2 rounded-xl px-3 py-2.5"
              >
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-white/10 text-[11px] font-bold text-zinc-300">
                  {i + 1}
                </span>
                <p className="min-w-0 flex-1 text-sm text-zinc-200">{f}</p>
                <button
                  onClick={() => forget(f)}
                   title="Forget"
                  className="shrink-0 rounded-lg p-1.5 text-zinc-600 opacity-0 transition group-hover:opacity-100 hover:bg-white/10 hover:text-white"
                >
                  <Trash2 size={13} />
                </button>
              </motion.div>
            ))}
          </AnimatePresence>
        </motion.div>

        <p className="mt-4 text-[11px] text-zinc-600">
           Do not store passwords, API keys, or tokens here — use /settings instead.
        </p>
      </motion.div>
    </div>
  );
}
