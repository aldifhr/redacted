import { createHash } from "node:crypto";

// Observation deduplication (audit phase 4B).
//
// Content-addressed: the fingerprint covers the FULL observation, so any
// material page change (cart add, modal open, lazy load, filter change,
// form state) produces a different hash and is never deduplicated.
// Only byte-identical observations of the same URL are suppressed.
//
// Per-run, in-memory: the evidence store keeps every payload on disk;
// this map only decides what the model context re-sends.

type SeenEntry = { hash: string; evidenceId: string; at: number };

const seen = new Map<string, Map<string, SeenEntry>>();

export function fingerprint(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export type DedupResult = {
  duplicate: boolean;
  hash: string;
  previousEvidenceId?: string;
};

/** Check (without recording) whether this exact observation was already sent. */
export function checkDuplicate(runId: string, url: string, content: string): DedupResult {
  const hash = fingerprint(content);
  const prev = seen.get(runId)?.get(url);
  if (prev && prev.hash === hash) {
    return { duplicate: true, hash, previousEvidenceId: prev.evidenceId };
  }
  return { duplicate: false, hash };
}

/** Record an observation as sent (call after it enters the context). */
export function rememberObservation(runId: string, url: string, content: string, evidenceId: string): void {
  let byUrl = seen.get(runId);
  if (!byUrl) {
    byUrl = new Map();
    seen.set(runId, byUrl);
  }
  byUrl.set(url, { hash: fingerprint(content), evidenceId, at: Date.now() });
}

export function clearObservations(runId: string): void {
  seen.delete(runId);
}
