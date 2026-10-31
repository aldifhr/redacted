/* eslint-disable @next/next/no-img-element */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowLeft,
  Bot,
  Brain,
  Camera,
  Check,
  Eye,
  EyeOff,
  Globe,
  Loader2,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DEFAULT_BASE_URLS, PROVIDERS, VAULT_MARKER, ProviderId } from "@/lib/providers";
import { Settings, ATTACHMENT_CAPS, loadSettings } from "@/lib/store";
import { useAppStore } from "@/lib/app-store";
import { useToast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const META: Record<ProviderId, { icon: typeof Sparkles; hint: string }> = {
  openai: { icon: Sparkles, hint: "GPT • API key required" },
  anthropic: { icon: Brain, hint: "Claude • API key required" },
};

const section = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0 },
};

type KeyInfo = { provider: ProviderId; fingerprint: string; updatedAt: number };

export default function SettingsPage() {
  // Settings tinggal di zustand store (yang sekarang persist ke localStorage),
  // jadi /chat dan halaman lain langsung lihat perubahan tanpa reload.
  const settings = useAppStore((state) => state.settings);
  const setSettings = useAppStore((state) => state.setSettings);
  const [showKey, setShowKey] = useState(false);
  const [saved, setSaved] = useState(false);
  // Key yang sedang diketik — tidak pernah masuk localStorage; langsung
  // dikirim ke POST /api/keys (server vault) begitu debounce selesai.
  const [draft, setDraft] = useState("");
  const [testing, setTesting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [test, setTest] = useState<{ title: string; url: string; image: string } | null>(null);
  const [testError, setTestError] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { success, error: showError } = useToast();
  const queryClient = useQueryClient();

  const provider = settings.provider;
  const baseUrl = settings.baseUrls[provider] ?? "";
  const draftKey = draft.trim();

  // ── Query: daftar key tersimpan di server (fingerprint saja) ──
  const keysQuery = useQuery({
    queryKey: ["keys"],
    queryFn: async (): Promise<KeyInfo[]> => {
      const r = await fetch("/api/keys");
      const d = await r.json();
      return Array.isArray(d.keys) ? (d.keys as KeyInfo[]) : [];
    },
  });
  const vault = useMemo<Partial<Record<ProviderId, string>>>(() => {
    const map: Partial<Record<ProviderId, string>> = {};
    for (const k of keysQuery.data ?? []) map[k.provider] = k.fingerprint;
    return map;
  }, [keysQuery.data]);
  const vaultFingerprint = vault[provider] ?? "";
  const hasKey = !!draftKey || !!vaultFingerprint;

  // ── Mutation: simpan / hapus key di vault server ──
  const saveMutation = useMutation({
    mutationFn: async (vars: { provider: ProviderId; apiKey: string; baseUrl: string }) => {
      const r = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vars),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Failed to save key");
      return d as { fingerprint: string };
    },
    onSuccess: (d, vars) => {
      setDraft("");
      void queryClient.invalidateQueries({ queryKey: ["keys"] });
      success(
        "API key saved on server",
        `${PROVIDERS[vars.provider].label} • sha256:${d.fingerprint}`
      );
    },
    onError: (e) => {
      showError("Key not saved", e instanceof Error ? e.message : "Failed to save key");
    },
  });

  const removeMutation = useMutation({
    mutationFn: async (p: ProviderId) => {
      const r = await fetch("/api/keys", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: p }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Failed to remove key");
      return d;
    },
    onSuccess: (_d, p) => {
      void queryClient.invalidateQueries({ queryKey: ["keys"] });
      success("API key removed", `${PROVIDERS[p].label} key deleted from this server.`);
    },
    onError: (e) => {
      showError("Remove failed", e instanceof Error ? e.message : "Failed");
    },
  });

  // ── Query: daftar model live ──
  // Selalu dari vault (server yang resolve key). queryKey memuat fingerprint:
  // begitu key diganti, key berubah → model otomatis dimuat ulang.
  const modelsQuery = useQuery({
    queryKey: ["models", provider, baseUrl, vaultFingerprint],
    queryFn: async (): Promise<string[]> => {
      const r = await fetch("/api/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, apiKey: VAULT_MARKER, baseUrl }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Failed to load models");
      return Array.isArray(d.models) ? (d.models as string[]) : [];
    },
    // Tanpa key tersimpan tidak ada yang bisa dilisting.
    enabled: !!vaultFingerprint,
    retry: false,
  });
  const liveModels = modelsQuery.data ?? null;
  const modelsError = modelsQuery.isError
    ? ((modelsQuery.error as Error)?.message ?? "Failed to load models")
    : "";

  const patch = useCallback(
    (p: Partial<Settings>) => {
      // baca dari store, bukan closure, supaya patch berturut-turut aman
      setSettings({ ...useAppStore.getState().settings, ...p });
      setSaved(true);
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaved(false), 1200);
    },
    [setSettings]
  );

  function changeProvider(p: ProviderId) {
    patch({ provider: p, model: PROVIDERS[p].models[0] });
    success("Provider changed", PROVIDERS[p].label);
  }

  function refreshModels() {
    if (!vaultFingerprint) {
      showError("Error", "Enter an API key first");
      return;
    }
    void modelsQuery.refetch().then((r) => {
      if (r.data?.length) success("Models loaded", `${r.data.length} models available`);
    });
  }

  function removeKey() {
    removeMutation.mutate(provider);
  }

  // hidrasi deferred agar render pertama identik SSR + migrasi key lama
  useEffect(() => {
    const t = setTimeout(() => {
      const loaded = loadSettings();
      setSettings(loaded);
      // Migrasi sekali jalan: key mentah lama di localStorage dipindah ke
      // vault server, lalu localStorage hanya menyimpan marker.
      const legacy = (Object.keys(PROVIDERS) as ProviderId[])
        .map((p) => ({ p, key: (loaded.keys[p] ?? "").trim() }))
        .filter((x) => x.key && x.key !== VAULT_MARKER);
      if (!legacy.length) return;
      void (async () => {
        const moved: ProviderId[] = [];
        for (const { p, key } of legacy) {
          try {
            const r = await fetch("/api/keys", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ provider: p, apiKey: key, baseUrl: loaded.baseUrls[p] ?? "" }),
            });
            const d = await r.json();
            if (!r.ok) throw new Error(d.error || "rejected");
            moved.push(p);
            success("API key moved to server", `${PROVIDERS[p].label} • sha256:${d.fingerprint}`);
          } catch (e) {
            showError(
              "Could not move key to server",
              `${PROVIDERS[p].label}: ${e instanceof Error ? e.message : "failed"}`
            );
          }
        }
        if (moved.length) {
          const current = useAppStore.getState().settings;
          setSettings({
            ...current,
            keys: {
              ...current.keys,
              ...Object.fromEntries(moved.map((p) => [p, VAULT_MARKER])),
            },
          });
          void queryClient.invalidateQueries({ queryKey: ["keys"] });
        }
      })();
    }, 0);
    return () => clearTimeout(t);
  }, [setSettings, success, showError, queryClient]);

  // Debounce: key yang diketik disimpan ke vault server (divalidasi ke
  // provider). Daftar model di-handle modelsQuery — fingerprint berubah →
  // queryKey berubah → model dimuat ulang otomatis.
  const saveMutateRef = useRef(saveMutation.mutate);
  useEffect(() => {
    saveMutateRef.current = saveMutation.mutate;
  }, [saveMutation.mutate]);
  useEffect(() => {
    if (!draftKey) return;
    const t = setTimeout(() => {
      saveMutateRef.current({ provider, apiKey: draftKey, baseUrl });
    }, 900);
    return () => clearTimeout(t);
  }, [provider, draftKey, baseUrl]);

  // kalau model tersimpan tidak ada di daftar live, pakai yang pertama.
  // Defer satu tick: hindari cascading render sinkron dari dalam effect.
  useEffect(() => {
    const list = modelsQuery.data;
    if (!list?.length) return;
    if (!list.includes(settings.model)) {
      const t = setTimeout(() => patch({ model: list[0] }), 0);
      return () => clearTimeout(t);
    }
  }, [modelsQuery.data, settings.model, patch]);

  async function testBrowser() {
    setTesting(true);
    setTestError("");
    setTest(null);
    try {
      const n = await fetch("/api/browser", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "navigate", url: "https://example.com" }),
      });
      const nd = await n.json();
       if (!n.ok) throw new Error(nd.error || "Navigation failed");
      const s = await fetch("/api/browser", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "screenshot" }),
      });
      const sd = await s.json();
       if (!s.ok) throw new Error(sd.error || "Screenshot failed");
      setTest({ title: nd.title || "Example Domain", url: nd.url, image: sd.image });
       success("Browser test passed", "Chromium navigated and captured a screenshot successfully");
    } catch (e) {
       const msg = e instanceof Error ? e.message : "Test failed";
      setTestError(msg);
       showError("Browser test failed", msg);
    } finally {
      setTesting(false);
    }
  }

  async function resetBrowser() {
    setResetting(true);
    try {
      const response = await fetch("/api/browser", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "close" }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Reset failed");
      setTest(null);
      setTestError("");
      success("Browser reset", "The active Chromium page was closed.");
    } catch (e) {
      showError("Browser reset failed", e instanceof Error ? e.message : "Reset failed");
    } finally {
      setResetting(false);
    }
  }

  const { model } = settings;
  const fallback = PROVIDERS[provider].models;
  const options = liveModels?.length
    ? (liveModels.includes(model) ? liveModels : [model, ...liveModels])
    : fallback.includes(model)
      ? fallback
      : [model, ...fallback];
  const filterQuery = modelFilter.trim().toLowerCase();
  const visibleOptions = filterQuery
    ? options.filter((m) => m.toLowerCase().includes(filterQuery))
    : options;
  const isCustomModel = !!model && !(liveModels?.length ? liveModels : fallback).includes(model);

  return (
    <div className="mesh-bg min-h-screen text-white">
      <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6">
        <motion.div variants={section} initial="hidden" animate="show">
          <Button variant="outline" size="sm" asChild>
               <Link href="/chat">
               <ArrowLeft size={15} /> Back to chat
            </Link>
          </Button>
        </motion.div>

        <motion.div
          variants={section}
          initial="hidden"
          animate="show"
          transition={{ delay: 0.05 }}
          className="mt-6 flex items-center gap-3"
        >
          <div className="grid h-11 w-11 place-items-center rounded-2xl bg-white shadow-lg shadow-white/10">
            <Bot size={22} className="text-black" />
          </div>
          <div>
             <h1 className="text-xl font-bold tracking-tight">Settings</h1>
            <AnimatePresence mode="wait">
              {saved ? (
                <motion.p
                  key="saved"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="flex items-center gap-1.5 text-xs text-zinc-400"
                >
                   <Check size={12} className="text-white" /> Saved automatically
                </motion.p>
              ) : (
                <motion.p
                  key="idle"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="text-xs text-zinc-500"
                >
                   AI model & connection • keys saved on this server
                </motion.p>
              )}
            </AnimatePresence>
          </div>
        </motion.div>

        {/* provider */}
        <motion.div
          variants={section}
          initial="hidden"
          animate="show"
          transition={{ delay: 0.1 }}
        >
          <Label className="mt-8 mb-2 text-[11px] font-semibold tracking-widest text-zinc-500 uppercase">
             AI Provider
          </Label>
          <div className="grid grid-cols-2 gap-2">
            {(Object.keys(PROVIDERS) as ProviderId[]).map((p) => {
              const Icon = META[p].icon;
              const active = provider === p;
              return (
                <motion.button
                  key={p}
                  onClick={() => changeProvider(p)}
                  whileTap={{ scale: 0.96 }}
                  whileHover={{ scale: 1.01 }}
                  className={`rounded-2xl border p-4 text-center transition ${
                    active
                      ? "border-white/50 bg-white/10 shadow-lg shadow-white/10"
                      : "border-white/10 bg-white/5 hover:bg-white/10"
                  }`}
                >
                  <Icon size={20} className={`mx-auto ${active ? "text-white" : "text-zinc-500"}`} />
                  <p className={`mt-2 text-sm font-semibold ${active ? "text-white" : "text-zinc-400"}`}>
                    {PROVIDERS[p].label}
                  </p>
                  <p className="mt-0.5 text-[11px] text-zinc-600">{META[p].hint}</p>
                </motion.button>
              );
            })}
          </div>
        </motion.div>

        {/* api key */}
        <motion.div
          variants={section}
          initial="hidden"
          animate="show"
          transition={{ delay: 0.15 }}
        >
          <div className="mt-6 mb-2 flex items-center gap-2">
            <Label className="text-[11px] font-semibold tracking-widest text-zinc-500 uppercase">
              API Key — {PROVIDERS[provider].label}
            </Label>
            {vaultFingerprint ? (
              <Badge className="gap-1 border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-300">
                <ShieldCheck size={10} /> saved on server
              </Badge>
            ) : null}
          </div>
          <div className="relative">
            <Input
              type={showKey ? "text" : "password"}
              placeholder={
                vaultFingerprint
                  ? `key saved on server • sha256:${vaultFingerprint}`
                  : "sk-... / sk-ant-..."
              }
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="dark:bg-white/5 border-white/10 pr-24 text-white placeholder:text-zinc-600"
            />
            <div className="absolute top-1/2 right-3 flex -translate-y-1/2 items-center gap-2">
              {saveMutation.isPending && <Loader2 size={14} className="animate-spin text-zinc-400" />}
              {vaultFingerprint && !saveMutation.isPending && (
                <ShieldCheck size={14} className="text-emerald-400" />
              )}
              <button
                onClick={() => setShowKey(!showKey)}
                className="text-zinc-500 hover:text-white"
                aria-label={showKey ? "Hide key" : "Show key"}
              >
                {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>
          {saveMutation.isError && (
            <p className="mt-1.5 text-[11px] text-red-300">
              ⚠ {(saveMutation.error as Error)?.message ?? "Failed to save key"}
            </p>
          )}
          {vaultFingerprint ? (
            <div className="mt-1.5 flex items-start gap-2 text-[11px] text-zinc-500">
              <span className="flex-1">
                Tersimpan di server ini — terenkripsi, hanya fingerprint{" "}
                <span className="font-mono text-zinc-400">sha256:{vaultFingerprint}</span> yang
                diketahui browser. Ketik key baru untuk mengganti.
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={removeKey}
                disabled={removeMutation.isPending}
                className="h-6 shrink-0 gap-1 px-2 text-[11px] text-red-300 hover:text-red-200"
              >
                {removeMutation.isPending ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
                Remove
              </Button>
            </div>
          ) : (
            <p className="mt-1.5 text-[11px] text-zinc-600">
              Disimpan di server ini saja (terenkripsi + di-hash) — key tidak pernah
              dikirim balik ke browser.
            </p>
          )}
        </motion.div>

        {/* base url */}
        <motion.div
          variants={section}
          initial="hidden"
          animate="show"
          transition={{ delay: 0.2 }}
        >
          <Label className="mt-6 mb-2 text-[11px] font-semibold tracking-widest text-zinc-500 uppercase">
            Base URL
          </Label>
          <Input
            value={baseUrl}
            placeholder={DEFAULT_BASE_URLS[provider]}
            onChange={(e) =>
              patch({ baseUrls: { ...settings.baseUrls, [provider]: e.target.value } })
            }
            className="dark:bg-white/5 border-white/10 text-white placeholder:text-zinc-600"
          />
          <p className="mt-1.5 text-[11px] text-zinc-600">
             Leave blank to use the default. The model list below loads automatically from this base URL and API key.
          </p>
        </motion.div>

        {/* model — shadcn Select */}
        <motion.div
          variants={section}
          initial="hidden"
          animate="show"
          transition={{ delay: 0.25 }}
        >
          <div className="mt-6 mb-2 flex items-center gap-2">
            <Label className="text-[11px] font-semibold tracking-widest text-zinc-500 uppercase">
              Model
            </Label>
            {modelsQuery.isFetching && <Loader2 size={12} className="animate-spin text-zinc-400" />}
            {liveModels?.length ? (
                 <Badge>{liveModels.length} live from API</Badge>
            ) : (
              <Badge variant="outline" className="text-zinc-500">
                 default
              </Badge>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={refreshModels}
              disabled={modelsQuery.isFetching || !hasKey}
              className="ml-auto h-7 text-[11px]"
            >
               <RefreshCw size={12} /> Refresh
            </Button>
          </div>
          {options.length > 15 && (
            <Input
              value={modelFilter}
              onChange={(e) => setModelFilter(e.target.value)}
              placeholder={`Filter ${options.length} models…`}
              className="mb-2 h-9 border-white/10 bg-white/5 text-xs text-white placeholder:text-zinc-600"
            />
          )}
          <Select value={model} onValueChange={(v) => patch({ model: v })}>
           <SelectTrigger className="dark:bg-white/5 border-white/10 w-full py-5 text-white">
               <SelectValue placeholder="Choose a model" />
            </SelectTrigger>
            <SelectContent>
              {visibleOptions.map((m) => (
                <SelectItem key={m} value={m}>
                  {m}
                </SelectItem>
              ))}
              {!visibleOptions.length && (
                <p className="px-2 py-3 text-xs text-zinc-500">No match — type the ID below.</p>
              )}
            </SelectContent>
          </Select>
          <div className="mt-2 flex items-center gap-2">
            <Input
              value={model}
              onChange={(e) => patch({ model: e.target.value })}
              placeholder="Or type any model ID (e.g. my-gateway/custom-model)"
              spellCheck={false}
              autoComplete="off"
              className="h-9 flex-1 border-white/10 bg-white/5 font-mono text-xs text-white placeholder:text-zinc-600"
            />
            {isCustomModel && (
              <Badge variant="outline" className="shrink-0 text-[10px] text-amber-200">
                custom
              </Badge>
            )}
          </div>
          {modelsError ? (
             <p className="mt-1.5 text-[11px] text-zinc-400">⚠ {modelsError} — using the default list.</p>
          ) : !hasKey ? (
            <p className="mt-1.5 text-[11px] text-zinc-600">
               Enter an API key to load the live model list from the API.
            </p>
          ) : null}
          <p className="mt-1.5 text-[11px] text-zinc-600">
             The key lives on this server (encrypted); this browser only keeps a marker.
          </p>
        </motion.div>

        {/* attachment size */}
        <motion.div
          variants={section}
          initial="hidden"
          animate="show"
          transition={{ delay: 0.25 }}
        >
          <Label className="mt-6 mb-2 text-[11px] font-semibold tracking-widest text-zinc-500 uppercase">
            Max attachment size (per file)
          </Label>
          <div className="grid grid-cols-3 gap-2">
            {ATTACHMENT_CAPS.map((cap) => (
              <button
                key={cap}
                onClick={() => patch({ attachmentCap: cap })}
                className={`rounded-2xl border p-3 text-center transition ${
                  settings.attachmentCap === cap
                    ? "border-white/50 bg-white/10"
                    : "border-white/10 bg-white/5 hover:bg-white/10"
                }`}
              >
                <p className={`text-sm font-semibold ${settings.attachmentCap === cap ? "text-white" : "text-zinc-400"}`}>
                  {(cap / 1000).toFixed(0)}k
                </p>
                <p className="mt-0.5 text-[10px] text-zinc-600">~{(cap / 4 / 1000).toFixed(1)}k tokens</p>
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-zinc-600">
            Larger files cost more tokens per message. The full file is sent up to this limit.
          </p>
        </motion.div>

        {/* playwright test */}
        <motion.div
          variants={section}
          initial="hidden"
          animate="show"
          transition={{ delay: 0.3 }}
        >
          <Label className="mt-8 mb-2 text-[11px] font-semibold tracking-widest text-zinc-500 uppercase">
             Playwright Integration
          </Label>
          <Card className="glass border-white/10 py-4">
            <CardContent className="px-4">
              <div className="flex items-center gap-2 text-sm">
                <Globe size={15} className="text-white" />
                <span className="font-medium">Chromium headless (server-side)</span>
                <Button
                  onClick={testBrowser}
                  disabled={testing}
                  size="sm"
                  className="ml-auto bg-white text-xs font-semibold text-black hover:bg-zinc-200"
                >
                  {testing ? <Loader2 size={13} className="animate-spin" /> : <Camera size={13} />}
                   {testing ? "Opening…" : "Test example.com"}
                </Button>
                <Button
                  onClick={resetBrowser}
                  disabled={testing || resetting}
                  size="sm"
                  variant="outline"
                  className="text-xs"
                >
                  {resetting ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
                  {resetting ? "Resetting…" : "Reset"}
                </Button>
              </div>
              {testError && <p className="mt-2 text-xs text-zinc-300">⚠ {testError}</p>}
              <AnimatePresence>
                {test && (
                  <motion.div
                    key={test.url}
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -12 }}
                    className="mt-3 overflow-hidden rounded-xl border border-white/10"
                  >
                    <p className="truncate border-b border-white/10 bg-black px-3 py-2 text-[11px] text-zinc-400">
                      {test.title} • {test.url}
                    </p>
                    <img src={test.image} alt={test.url} className="w-full grayscale" />
                  </motion.div>
                )}
              </AnimatePresence>
              {!test && !testError && (
                <p className="mt-2 text-xs text-zinc-600">
                   This test opens example.com with Playwright and captures a screenshot — no API key required.
                </p>
              )}
            </CardContent>
          </Card>
        </motion.div>
      </div>
    </div>
  );
}
