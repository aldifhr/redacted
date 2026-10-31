import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { PROVIDERS, VAULT_MARKER, type ProviderId } from "./providers";

// Server-only: vault API key provider LLM.
//
// Kenapa ada: key dulu hidup di localStorage browser dan dikirim ulang pada
// setiap request. Sekarang key disimpan di server (logs/keys.vault.json,
// ter-gitignore) dalam bentuk:
//   - ciphertext AES-256-GCM (kunci mesin: logs/vault.key, dibuat sekali)
//   - sha256(key) sebagai hash + fingerprint 12 hex untuk verifikasi & tampilan
// Key mentah tidak pernah ditulis ke disk dan tidak pernah dikirim balik ke
// browser — client hanya melihat fingerprint-nya.
//
// Semua operasi sinkron (pola yang sama dengan lib/memory.ts): proses ini
// single-threaded dan tidak ada await antara baca dan tulis, jadi tidak ada
// race dalam satu instance server.

const VAULT_VERSION = 1;

type VaultEntry = {
  hash: string;
  fingerprint: string;
  iv: string;
  tag: string;
  data: string;
  updatedAt: number;
};

type VaultFile = {
  version: number;
  keys: Partial<Record<ProviderId, VaultEntry>>;
};

const EMPTY: VaultFile = { version: VAULT_VERSION, keys: {} };

// KEY_VAULT_DIR hanya untuk test; default logs/ (sudah di .gitignore).
function vaultDir(): string {
  return process.env.KEY_VAULT_DIR?.trim() || join(process.cwd(), "logs");
}

function vaultPath(): string {
  return join(vaultDir(), "keys.vault.json");
}

function machineKeyPath(): string {
  return join(vaultDir(), "vault.key");
}

export function hashKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

// 12 hex pertama sha256 — aman ditampilkan (seperti fingerprint SSH).
export function fingerprintOf(key: string): string {
  return hashKey(key).slice(0, 12);
}

function isProviderId(value: string): value is ProviderId {
  return value === "openai" || value === "anthropic";
}

function readVault(): VaultFile {
  try {
    if (!existsSync(vaultPath())) return { ...EMPTY, keys: {} };
    const parsed = JSON.parse(readFileSync(vaultPath(), "utf-8")) as VaultFile;
    if (!parsed || typeof parsed !== "object" || !parsed.keys) return { ...EMPTY, keys: {} };
    return { version: VAULT_VERSION, keys: parsed.keys };
  } catch {
    // File rusak: perlakukan sebagai kosong daripada mematikan server.
    return { ...EMPTY, keys: {} };
  }
}

function writeVault(vault: VaultFile) {
  const dir = vaultDir();
  mkdirSync(dir, { recursive: true });
  const target = vaultPath();
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(vault, null, 2), "utf-8");
  renameSync(tmp, target);
}

function machineKey(): Buffer {
  const path = machineKeyPath();
  if (existsSync(path)) {
    const raw = readFileSync(path, "utf-8").trim();
    const buf = Buffer.from(raw, "base64");
    if (buf.length === 32) return buf;
    throw new Error("vault key file is corrupt (expected 32 bytes, base64) — delete logs/vault.key to re-create it");
  }
  const buf = randomBytes(32);
  mkdirSync(vaultDir(), { recursive: true });
  writeFileSync(path, buf.toString("base64"), "utf-8");
  try {
    // best effort; no-op di platform tanpa mode Unix
    chmodSync(path, 0o600);
  } catch {}
  return buf;
}

function encrypt(key: string): { iv: string; tag: string; data: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", machineKey(), iv);
  const data = Buffer.concat([cipher.update(key, "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

function decrypt(entry: VaultEntry): string | null {
  try {
    const decipher = createDecipheriv("aes-256-gcm", machineKey(), Buffer.from(entry.iv, "base64"));
    decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
    const out = Buffer.concat([
      decipher.update(Buffer.from(entry.data, "base64")),
      decipher.final(),
    ]);
    return out.toString("utf8");
  } catch {
    return null;
  }
}

export function saveKey(provider: ProviderId, apiKey: string): string {
  if (!isProviderId(provider)) throw new Error("unknown provider");
  const key = apiKey.trim();
  if (key.length < 8 || key.length > 500) throw new Error("api key must be 8-500 characters");
  const vault = readVault();
  const entry: VaultEntry = {
    hash: hashKey(key),
    fingerprint: fingerprintOf(key),
    ...encrypt(key),
    updatedAt: Date.now(),
  };
  vault.keys[provider] = entry;
  writeVault(vault);
  return entry.fingerprint;
}

export function getKey(provider: ProviderId): string | null {
  if (!isProviderId(provider)) return null;
  const entry = readVault().keys[provider];
  if (!entry) return null;
  return decrypt(entry);
}

export function hasKey(provider: ProviderId): boolean {
  if (!isProviderId(provider)) return false;
  return Boolean(readVault().keys[provider]);
}

// Verifikasi tanpa mendekripsi: bandingkan hash, constant-time.
export function verifyKey(provider: ProviderId, presented: string): boolean {
  if (!isProviderId(provider)) return false;
  const entry = readVault().keys[provider];
  if (!entry) return false;
  const expected = Buffer.from(entry.hash, "hex");
  const actual = Buffer.from(hashKey(presented.trim()), "hex");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export type KeyInfo = { provider: ProviderId; fingerprint: string; updatedAt: number };

export function listKeys(): KeyInfo[] {
  return (Object.entries(readVault().keys) as [ProviderId, VaultEntry][])
    .map(([provider, entry]) => ({
      provider,
      fingerprint: entry.fingerprint,
      updatedAt: entry.updatedAt,
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

export function deleteKey(provider: ProviderId): boolean {
  if (!isProviderId(provider)) return false;
  const vault = readVault();
  if (!vault.keys[provider]) return false;
  delete vault.keys[provider];
  writeVault(vault);
  return true;
}

// Urutan resolusi untuk satu request:
//   1. key yang dikirim client (bukan marker) — menang, untuk gateway sekali-pakai
//   2. key di vault server
//   3. error yang mengarahkan user ke /settings
export function resolveKey(provider: ProviderId, presented?: string): string {
  const sent = (presented ?? "").trim();
  if (sent && sent !== VAULT_MARKER) return sent;
  const stored = getKey(provider);
  if (stored) return stored;
  throw new Error(
    `${PROVIDERS[provider]?.label ?? provider} API key is required — add one in /settings (it is saved on this server)`
  );
}
