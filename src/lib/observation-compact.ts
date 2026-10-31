// Tool-result compaction (audit phase 4C/4D).
//
// Large tool results are represented in the model context by a concise
// summary + evidence ID; the full payload lives in the evidence store
// (lib/evidence-store) and stays retrievable via evidence_read. The
// agent is never cut off from data — it is told exactly which ID holds
// the full payload and how to fetch it.

import type { ModelMessage } from "ai";

/** Results above this many chars are compacted before entering context. */
export const COMPACT_THRESHOLD = 2_000;

export type CompactResult = {
  summary: string;
  compacted: boolean;
  originalChars: number;
};

function pathOf(url: string): string {
  try {
    return new URL(url).pathname || url;
  } catch {
    return url;
  }
}

function countSnapshot(elements: string): { total: number; interactive: number } {
  const lines = elements.split("\n").filter((l) => /^\s*\d+:\s/.test(l));
  const interactive = lines.filter((l) => /<(a|button|input|select|textarea)\b/i.test(l)).length;
  return { total: lines.length, interactive };
}

/**
 * Compact one tool result. Returns the summary to place in the model
 * context. Small results pass through untouched (compacted: false).
 */
export function compactToolResult(
  tool: string,
  output: unknown,
  evidenceId?: string
): CompactResult {
  const chars =
    typeof output === "string" ? output.length : (JSON.stringify(output)?.length ?? 0);
  const ref = evidenceId ? ` Full payload: ${evidenceId} (evidence_read).` : "";
  const base = { originalChars: chars };

  if (tool === "browser_snapshot") {
    const o = (output ?? {}) as { url?: string; title?: string; elements?: string };
    const elements = typeof o.elements === "string" ? o.elements : "";
    if (chars <= COMPACT_THRESHOLD) {
      return { summary: typeof output === "string" ? output : JSON.stringify(output), compacted: false, ...base };
    }
    const { total, interactive } = countSnapshot(elements);
    const title = o.title ? ` "${o.title}"` : "";
    return {
      summary:
        `Page snapshot${title} at ${pathOf(o.url ?? "")}: ${total} elements ` +
        `(${interactive} interactive). Compacted — full snapshot: ${evidenceId ?? "unavailable"} ` +
        `(evidence_read).${ref}`,
      compacted: true,
      ...base,
    };
  }

  if (tool === "browser_get_text") {
    const o = (output ?? {}) as { url?: string; text?: string };
    const text = typeof o.text === "string" ? o.text : "";
    if (chars <= COMPACT_THRESHOLD) {
      return { summary: typeof output === "string" ? output : JSON.stringify(output), compacted: false, ...base };
    }
    return {
      summary:
        `Visible text at ${pathOf(o.url ?? "")}: ${text.length.toLocaleString()} chars ` +
        `(compacted). Full text: ${evidenceId ?? "unavailable"} (evidence_read).${ref}`,
      compacted: true,
      ...base,
    };
  }

  if (tool === "browser_screenshot") {
    const o = (output ?? {}) as { url?: string; image?: string };
    const kb = Math.round((o.image?.length ?? 0) / 1024);
    return {
      summary:
        `Screenshot captured at ${pathOf(o.url ?? "")} (~${kb}KB base64). ` +
        `Image data is kept in evidence, not in context: ${evidenceId ?? "unavailable"} ` +
        `(evidence_read).${ref}`,
      compacted: true,
      ...base,
    };
  }

  if (tool === "browser_network_log" || tool === "browser_console") {
    const o = (output ?? {}) as { url?: string; entries?: unknown[] };
    const n = Array.isArray(o.entries) ? o.entries.length : 0;
    if (chars <= COMPACT_THRESHOLD) {
      return { summary: typeof output === "string" ? output : JSON.stringify(output), compacted: false, ...base };
    }
    const label = tool === "browser_network_log" ? "network requests" : "console entries";
    return {
      summary:
        `${label} at ${pathOf(o.url ?? "")}: ${n} entries (compacted). ` +
        `Full log: ${evidenceId ?? "unavailable"} (evidence_read).${ref}`,
      compacted: true,
      ...base,
    };
  }

  // Everything else: small results pass through; large ones get a
  // generic pointer so no raw blob silently enters the context.
  if (chars <= COMPACT_THRESHOLD) {
    return { summary: typeof output === "string" ? output : JSON.stringify(output), compacted: false, ...base };
  }
  return {
    summary:
      `${tool} result at ${pathOf(String((output as { url?: string })?.url ?? ""))}: ` +
      `${chars.toLocaleString()} chars (compacted). Full result: ${evidenceId ?? "unavailable"} ` +
      `(evidence_read).${ref}`,
    compacted: true,
    ...base,
  };
}

/** Marker that replaces a byte-identical repeat observation (phase 4B). */
export function duplicateMarker(tool: string, url: string, previousEvidenceId: string): string {
  return (
    `Duplicate observation suppressed: ${tool} at ${pathOf(url)} is unchanged ` +
    `since ${previousEvidenceId}. Do not re-read it; retrieve ${previousEvidenceId} ` +
    `via evidence_read only if you need details you no longer have.`
  );
}

/**
 * Replace tool outputs in assistant response messages before they enter
 * the conversation history. Overrides are keyed by toolCallId; messages
 * without an override pass through untouched.
 */
export function rewriteToolOutputs(
  messages: ModelMessage[],
  overrides: Map<string, string>
): ModelMessage[] {
  if (!overrides.size) return messages;
  return messages.map((m) => {
    if (m.role !== "tool") return m;
    const content = m.content;
    if (!Array.isArray(content)) return m;
    let changed = false;
    const next = content.map((part) => {
      const p = part as { type?: string; toolCallId?: string; toolName?: string };
      if (p?.type === "tool-result" && p.toolCallId && overrides.has(p.toolCallId)) {
        changed = true;
        return {
          ...p,
          output: { type: "text", value: overrides.get(p.toolCallId)! },
        } as typeof part;
      }
      return part;
    });
    return changed ? { ...m, content: next } : m;
  });
}
