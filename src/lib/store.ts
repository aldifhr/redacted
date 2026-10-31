import { DEFAULT_BASE_URLS, PROVIDERS, ProviderId } from "./providers";
import { format } from "date-fns";

export type Role = "user" | "assistant";
export type ToolCall = { tool: string; input: unknown };
export type Shot = { url: string; image: string };
export type ChatMsg = {
  role: Role;
  content: string;
  toolCalls?: ToolCall[];
  screenshots?: Shot[];
  artifacts?: { kind: string; file: string; meta: Record<string, unknown> }[];
  thinking?: (string | { text: string; phase?: string })[];
  model?: string;
  skills?: string[];
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  time?: string;
};

export type Session = {
  id: string;
  title: string;
  messages: ChatMsg[];
  createdAt: number;
  updatedAt: number;
};

export const ATTACHMENT_CAPS = [8_000, 20_000, 50_000] as const;

export type Settings = {
  provider: ProviderId;
  model: string;
  // Nilai tiap entri: VAULT_MARKER (key asli sudah di vault server) atau key
  // mentah legacy yang masih hanya di browser ini.
  keys: Partial<Record<ProviderId, string>>;
  baseUrls: Record<ProviderId, string>;
  attachmentCap: number;
};

const S_KEY = "pw_settings_v1";
const L_KEY = "pw_sessions_v1";
const A_KEY = "pw_active_v1";
const MAX_SESSIONS = 100;

export function defaultSettings(): Settings {
  return {
    provider: "openai",
    model: PROVIDERS.openai.models[0],
    keys: {},
    baseUrls: { ...DEFAULT_BASE_URLS },
    attachmentCap: 20_000,
  };
}

export function loadSettings(): Settings {
  const d = defaultSettings();
  if (typeof window === "undefined") return d;
  try {
    // migrasi key lama format key_<provider>
    const legacy: Partial<Record<ProviderId, string>> = {};
    (Object.keys(PROVIDERS) as ProviderId[]).forEach((p) => {
      const v = localStorage.getItem(`key_${p}`);
      if (v) legacy[p] = v;
    });
    const raw = localStorage.getItem(S_KEY);
    if (!raw) return { ...d, keys: legacy };
    const s = JSON.parse(raw) as Partial<Settings>;
    const provider =
      s.provider && PROVIDERS[s.provider] ? s.provider : d.provider;
    const baseUrls = { ...DEFAULT_BASE_URLS, ...(s.baseUrls ?? {}) };
    const attachmentCap = ATTACHMENT_CAPS.includes(s.attachmentCap as (typeof ATTACHMENT_CAPS)[number])
      ? (s.attachmentCap as number)
      : defaultSettings().attachmentCap;
    return {
      provider,
      model:
        typeof s.model === "string" && s.model
          ? s.model
          : PROVIDERS[provider].models[0],
      keys: { ...legacy, ...(s.keys ?? {}) },
      baseUrls,
      attachmentCap,
    };
  } catch {
    return d;
  }
}

export function saveSettings(s: Settings) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(S_KEY, JSON.stringify(s));
  } catch {}
}

export function uid(): string {
  return (
    Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
  );
}

export function newSession(): Session {
  const t = Date.now();
  return { id: uid(), title: "New chat", messages: [], createdAt: t, updatedAt: t };
}

export function titleFrom(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) return "New chat";
  return t.length > 42 ? t.slice(0, 42) + "…" : t;
}

function stripImages(ss: Session[]): Session[] {
  // kuota localStorage penuh → buang array screenshots sekalian
  // (menyisakan image:"" bikin <img src=""> error di console)
  return ss.map((s) => ({
    ...s,
    messages: s.messages.map((m) =>
      m.screenshots?.length ? { ...m, screenshots: [] } : m
    ),
  }));
}

export function loadSessions(): Session[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(L_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((s): s is Session => !!s && typeof (s as Session).id === "string")
      .map((s) => ({
        id: s.id,
        title: String(s.title || "New chat"),
        messages: Array.isArray(s.messages) ? s.messages : [],
        createdAt: Number(s.createdAt) || 0,
        updatedAt: Number(s.updatedAt) || 0,
      }));
  } catch {
    return [];
  }
}

export function saveSessions(ss: Session[]) {
  if (typeof window === "undefined") return;
  // Keep a generous bounded history: 30 silently discarded older chats.
  const capped = ss.slice(0, MAX_SESSIONS);
  try {
    localStorage.setItem(L_KEY, JSON.stringify(capped));
  } catch {
    // localStorage penuh (screenshot base64) → simpan tanpa gambar
    try {
      localStorage.setItem(L_KEY, JSON.stringify(stripImages(capped)));
    } catch {}
  }
}

export function loadActiveId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(A_KEY);
  } catch {
    return null;
  }
}

export function saveActiveId(id: string) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(A_KEY, id);
  } catch {}
}

export function fmtTime(ts: number): string {
  if (!ts) return "";
  try {
    return format(new Date(ts), "d MMM, HH:mm");
  } catch {
    return "";
  }
}
