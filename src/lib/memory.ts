import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// Server-only: ingatan jangka panjang di MEMORY.md (repo root).
// Format: satu fakta per baris diawali "- ".

const PATH = join(process.cwd(), "MEMORY.md");
const MAX_FACTS = 100;
const MAX_LEN = 200;

const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9-_]{8,}/,
  /sk-ant-[a-zA-Z0-9-_]{8,}/,
  /ghp_[a-zA-Z0-9]{8,}/,
  /xox[bpas]-[a-zA-Z0-9-]+/,
  /AKIA[0-9A-Z]{16}/,
  /bearer\s+[a-zA-Z0-9\-._~+/=]{20,}/i,
];

function readFile(): string {
  try {
    return existsSync(PATH) ? readFileSync(PATH, "utf-8") : "";
  } catch {
    return "";
  }
}

function writeFile(content: string) {
  writeFileSync(PATH, content.endsWith("\n") ? content : content + "\n", "utf-8");
}

export function listFacts(): string[] {
  return readFile()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim())
    .filter(Boolean);
}

// Isi mentah MEMORY.md untuk disuntik ke system prompt.
export function loadMemory(): string {
  const facts = listFacts();
  if (!facts.length) return "";
  return facts.map((f) => `- ${f}`).join("\n");
}

function looksSecret(fact: string): boolean {
  if (SECRET_PATTERNS.some((p) => p.test(fact))) return true;
  // pola "password/kunci ... = <nilai panjang>" walau bukan format dikenal
  if (
    /(password|passwd|api[\s_-]?key|secret|token)\s*[:=]\s*\S{12,}/i.test(fact)
  ) {
    // kecuali kredensial demo publik yang eksplisit ditandai
    if (!/demo|publik|contoh/i.test(fact)) return true;
  }
  return false;
}

export function saveFact(fact: string): { saved: string; total: number } {
  const clean = String(fact ?? "")
    .trim()
    // Normalize: agents often submit "- fact" or "1. fact" — strip list markers
    // so MEMORY.md never gets "- - " double bullets.
    .replace(/^([-*•\d]+[.)\s]+)+/, "")
    .replace(/\s+/g, " ")
    .slice(0, MAX_LEN);
  if (!clean) throw new Error("fact cannot be empty");
  if (looksSecret(clean)) {
    throw new Error(
      "rejected: do not store passwords, API keys, or tokens in memory. Store them in /settings instead."
    );
  }
  const facts = listFacts();
  const norm = clean.toLowerCase();
  if (facts.some((f) => f.toLowerCase() === norm)) {
    return { saved: clean, total: facts.length };
  }
  if (facts.length >= MAX_FACTS) {
    throw new Error(
      `memory is full (${MAX_FACTS} facts) — remove an outdated fact with memory_forget first`
    );
  }
  const raw = readFile();
  const block = `## Fakta`;
  const line = `- ${clean}`;
  if (raw.includes(block)) {
    writeFile(raw.replace(/\s+$/, "") + `\n${line}\n`);
  } else {
    writeFile(
      `${raw.replace(/\s+$/, "")}\n\n${block}\n${line}\n`
    );
  }
  return { saved: clean, total: facts.length + 1 };
}

export function forgetFact(query: string): { removed: number; total: number } {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) throw new Error("keyword cannot be empty");
  const raw = readFile();
  const lines = raw.split("\n");
  const factOf = (line: string) => line.trim().slice(2).trim().toLowerCase();
  // Exact line match wins; a keyword search is only the fallback, so deleting
  // one fact can never take unrelated facts that merely share the words.
  const exact = lines.some((l) => l.trim().startsWith("- ") && factOf(l) === q);
  const kept = lines.filter((l) => {
    const t = l.trim();
    if (!t.startsWith("- ")) return true;
    const fact = factOf(l);
    return exact ? fact !== q : !fact.includes(q);
  });
  const removed = lines.length - kept.length;
  if (removed > 0) writeFile(kept.join("\n"));
  return { removed, total: listFacts().length };
}
