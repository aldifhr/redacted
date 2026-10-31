import { z } from "zod";

// ---------------------------------------------------------------------------
// Structured report generation: LLM returns DATA ONLY (JSON), server owns
// status + rendering. This is the architectural fix for hallucinated tables
// ("Navigation: Verified", "no rate limiting", invented locator patterns).
// Free-form Markdown from the model is never trusted for final status.
// ---------------------------------------------------------------------------

export const ReportFeatureSchema = z.object({
  text: z.string().min(1).max(300).describe("One observed feature, plain words"),
  quote: z
    .string()
    .max(500)
    .default("")
    .describe(
      "Short string copied VERBATIM from a browser tool output (snapshot line, visible text, assertion result, or used selector) proving this feature. Features whose quote is missing or not found verbatim are dropped."
    ),
});

export const ReportAreaSchema = z.object({
  area: z.string().min(1).max(80),
  features: z.array(ReportFeatureSchema).max(20).default([]),
  evidence: z.array(z.string().max(500)).max(20).default([]),
  gaps: z.string().max(500).default(""),
});

export const ReportLocatorSchema = z.object({
  element: z.string().min(1).max(120),
  locator: z.string().min(1).max(300),
  type: z.string().min(1).max(60),
});

export const ReportDataSchema = z.object({
  summary: z.string().min(1).max(2000),
  areas: z.array(ReportAreaSchema).max(30).default([]),
  locators: z.array(ReportLocatorSchema).max(40).default([]),
  gaps: z.array(z.string().max(500)).max(20).default([]),
});

export type ReportData = z.infer<typeof ReportDataSchema>;
export type ReportStatus = "Verified" | "Partially verified" | "Visited only" | "Planned/Unverified";

export type EvidenceEntry = {
  tool: string;
  url: string;
  /** CSS selector the tool acted on / asserted (if any). */
  selector?: string;
  /** Short excerpt of what the tool observed (snapshot line, text, assert actual). */
  excerpt?: string;
  /** Assertion outcome, when tool is test_assert. */
  pass?: boolean;
  /** Assertion kind, when tool is test_assert. */
  assertKind?: string;
  /** Evidence store ID for the full payload (phase 3+). */
  evidenceId?: string;
};

export type Coverage = {
  requestedAreas: string[];
  visitedAreas: string[];
  coveredAreas: string[];
  /** Backend-authoritative per-area statuses (phase 8). */
  areaStatuses?: Record<string, string>;
  /** Overall run status (phase 9). */
  overall?: "COMPLETE" | "PARTIAL" | "FAILED" | "BLOCKED";
};

export type TestRunSummary = {
  file?: string;
  ok?: boolean;
  passed?: number;
  failed?: number;
  error?: string;
};

// URL → area mapping (single source of truth; also used by the stream route
// for visited/verified tracking). Known mappings first; then a GENERIC
// fallback so any requested area name (on any future website) can verify by
// URL: path segments are compared compaction-wise against the area name
// ("user-settings" ↔ "user settings", "catalog" ↔ "dynamic catalog").
export function areaForUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const path = new URL(value).pathname.toLowerCase();
    if (path.includes("checkout")) return "checkout";
    // Segment-scoped so "/cartoon" or "/carted" never maps to the cart area.
    if (/(^|\/)cart(\/|$)/.test(path)) return "cart";
    if (path.includes("dynamic-catalog")) return "dynamic catalog";
    if (path.includes("inventory")) return "products";
  } catch {}
  // The site root is not inherently a login page; urlMatchesArea resolves
  // root-level areas (login/home/landing) against the requested area name.
  return null;
}

const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export function urlMatchesArea(url: unknown, area: string): boolean {
  if (typeof url !== "string" || !url) return false;
  const direct = areaForUrl(url);
  if (direct && norm(direct) === norm(area)) return true;
  try {
    const parsedUrl = new URL(url);
    const path = parsedUrl.pathname.toLowerCase();
    const root = path === "/" || path.endsWith("/index.html");
    const want = compact(area);
    if (!want || want.length < 3) return false;
    if (root && (want === "login" || want === "home" || want === "homepage" || want === "landing")) {
      return true;
    }
    const segs = path.split(/[/\-_.]+/).filter(Boolean);
    return segs.some((sg) => {
      const c = compact(sg);
      // Exact token, or a segment covered by a more specific area name
      // ("dynamic catalog" ⊇ "catalog"). No substring match, so "cartoon"
      // can never verify the "cart" area.
      return c.length >= 3 && (c === want || want.includes(c));
    });
  } catch {
    return false;
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return url.slice(0, 60);
  }
}

// A successful snapshot of an error page is not verification. Detected by
// content markers (not HTTP status — the tool layer doesn't expose it).
const ERROR_PAGE_MARKERS = [
  "404",
  "page not found",
  "404 not found",
  "could not be found",
  "page could not be found",
  "application error",
  "something went wrong",
  "err_connection",
  "err_name_not_resolved",
  "this site can’t be reached",
  "this site can't be reached",
];

export function looksLikeErrorPage(text: string | undefined): boolean {
  if (!text) return false;
  const low = text.toLowerCase();
  // "404" alone is too trigger-happy (prices, item counts); require it to
  // look like a status/title, or pair it with another marker.
  if (/\b404\b/.test(low)) {
    if (/title|error|status|not found|page/.test(low)) return true;
    const others = ERROR_PAGE_MARKERS.slice(1).some((m) => low.includes(m));
    if (others) return true;
  }
  return ERROR_PAGE_MARKERS.slice(1).some((m) => low.includes(m));
}

// Some areas have no dedicated URL: navigation lives on content pages
// (burger menu / sidebar), footer lives below the fold. They are detected
// from interaction evidence — selectors used and snapshot content — instead.
const NAV_HINTS = [
  "react-burger-menu",
  "sidebar_link",
  "sidebar-link",
  "bm-menu",
  "bm-icon",
  "bm-item",
  "burger",
];
const FOOTER_HINTS = ["<footer", "site-footer", "page-footer", "social", "linkedin", "twitter", "facebook", "youtube"];

export function areaSignalsFor(selector: string | undefined, excerpt: string | undefined): string[] {
  const hay = `${selector ?? ""}\n${excerpt ?? ""}`.toLowerCase();
  const out: string[] = [];
  if (NAV_HINTS.some((h) => hay.includes(h))) out.push("navigation");
  if (FOOTER_HINTS.some((h) => hay.includes(h))) out.push("footer");
  return out;
}

/** All ledger entries attributable to one area: URL match (generic, so any
 *  area name works on any site) or interaction signals (URL-less areas like
 *  navigation/footer, and URL-less outputs like test_assert). */
export function ledgerEntriesFor(area: string, ledger: EvidenceEntry[]): EvidenceEntry[] {
  const key = norm(area);
  return ledger.filter(
    (e) => urlMatchesArea(e.url, area) || areaSignalsFor(e.selector, e.excerpt).includes(key)
  );
}

const VERIFY_TOOLS = new Set(["browser_snapshot", "browser_get_text", "test_assert"]);

/** Ledger-direct status for areas outside the requested scope (extras): a
 *  verify-tool entry mapped to the area means Verified — this is how a
 *  generically-scoped run ("primary flow") still credits real evidence. */
export function ledgerStatus(area: string, ledger: EvidenceEntry[]): ReportStatus {
  const entries = ledgerEntriesFor(area, ledger).filter(
    (e) => !(e.excerpt ?? "").startsWith("[possible error page]")
  );
  if (entries.some((e) => VERIFY_TOOLS.has(e.tool))) return "Verified";
  if (entries.length) return "Visited only";
  return "Planned/Unverified";
}

/** Server-built evidence lines for one area, straight from the ledger. */
export function evidenceForArea(area: string, ledger: EvidenceEntry[]): string {
  const entries = ledgerEntriesFor(area, ledger);
  if (!entries.length) return "";
  return entries
    .slice(0, 6)
    .map((e) => {
      let s = e.tool.replace(/^browser_/, "");
      if (e.selector) s += ` [${e.selector}]`;
      if (e.pass !== undefined) s += e.pass ? " PASS" : " FAIL";
      if (e.url) s += ` @ ${pathOf(e.url)}`;
      return s;
    })
    .join("; ");
}

/** An LLM evidence string is kept only when quoted verbatim from the ledger. */
function evidenceSupported(ev: string, ledger: EvidenceEntry[]): boolean {
  const low = ev.toLowerCase();
  return ledger.some(
    (e) =>
      (e.excerpt ?? "").toLowerCase().includes(low) ||
      (e.selector ?? "").toLowerCase().includes(low) ||
      (e.url ?? "").toLowerCase().includes(low)
  );
}

// A feature that names a selector must name one actually observed this run.
// Plain-language features (no selector tokens) are kept — the area status
// gate plus the server-built evidence column keep them auditable.
const SELECTOR_TOKEN = /(#[A-Za-z][\w-]*)|(\.[A-Za-z][\w-]*)|(\[[^\][\s=]+[^\]]*\])|\b(getBy[A-Za-z]+)/g;

function featureSupported(feat: string, ledger: EvidenceEntry[]): boolean {
  const tokens = feat.match(SELECTOR_TOKEN) ?? [];
  return tokens.every((t) => {
    if (t.startsWith("getBy")) return false;
    const core = (t.startsWith("[") ? t.slice(1).split(/[\s=\]'"]+/)[0] : t).toLowerCase();
    if (!core) return false;
    return ledger.some(
      (e) =>
        (e.selector ?? "").trim().toLowerCase() === core ||
        (e.excerpt ?? "").toLowerCase().includes(core)
    );
  });
}

// Every feature must be anchored: a verbatim quote found in the ledger,
// plus at least one content word shared with the observations. This kills
// plain-language inflation such as "invalid credentials tested" when only a
// valid login ran — while keeping genuinely observed features.
const STOPWORDS = new Set(
  "the,and,for,with,from,that,this,these,those,have,has,had,were,been,will,would,into,page,pages,shows,shown,found,area,areas,site,sites,also,when,then,than,such,each,other,more,most,some,what,which,while,after,before,over,under,between,through,during,about,using,used,plus,per,via,can,all,any,are,was,our,you,your,they,them,their,its,not,but,just,like,well,very,too,only,even,has,had".split(
    ","
  )
);

function contentWords(s: string): string[] {
  return (s.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !STOPWORDS.has(w));
}

function quoteSupported(quote: string, ledger: EvidenceEntry[]): boolean {
  const q = quote.trim().toLowerCase();
  if (q.length < 6) return false;
  return ledger.some(
    (e) =>
      (e.excerpt ?? "").toLowerCase().includes(q) ||
      (e.selector ?? "").toLowerCase().includes(q)
  );
}

function keptFeatures(
  features: { text: string; quote?: string }[],
  ledger: EvidenceEntry[],
  ledgerText: string
): string[] {
  const out: string[] = [];
  for (const f of features) {
    const sentences = sanitizeList([f.text], ledger);
    if (!sentences.length) continue;
    const text = sentences.join(" ");
    if (!featureSupported(text, ledger)) continue;
    if (!quoteSupported(f.quote ?? "", ledger)) continue;
    const words = contentWords(text);
    if (words.length && !words.some((w) => ledgerText.includes(w))) continue;
    out.push(text);
  }
  return out;
}

function norm(value: string) {
  return value.trim().toLowerCase();
}

// Claims that require a dedicated passing assertion. Without one they are
// dropped — "not observed" / Unverified is the only safe wording.
const BANNED_CLAIMS: { pattern: RegExp; label: string }[] = [
  { pattern: /\bno\s+(captcha|capcha)\b/i, label: "CAPTCHA absence" },
  { pattern: /\bno\s+rate\s*limiting\b/i, label: "rate-limit absence" },
  { pattern: /\bno\s+bot\s+checks?\b/i, label: "bot-check absence" },
  { pattern: /\bno\s+auth\s+wall\b/i, label: "auth-wall absence" },
  { pattern: /\bfully\s+testable\b/i, label: "full testability" },
  { pattern: /\ball\s+areas?\s+(are\s+)?accessible\b/i, label: "universal accessibility" },
  { pattern: /\bno\s+console\s+errors?\b/i, label: "console-error absence" },
];

function hasProvingAssertion(ledger: EvidenceEntry[], label: string): boolean {
  // A proving assertion is a PASSING test_assert whose excerpt mentions the
  // claimed subject. Conservative: label keyword must appear in the excerpt.
  const keyword = label.split(" ")[0].toLowerCase();
  return ledger.some(
    (e) =>
      e.tool === "test_assert" &&
      e.pass === true &&
      (e.excerpt ?? "").toLowerCase().includes(keyword)
  );
}

/** Drop banned absolute claims unless a passing assertion proves them. */
export function sanitizeSentence(sentence: string, ledger: EvidenceEntry[]): string | null {
  for (const { pattern, label } of BANNED_CLAIMS) {
    if (pattern.test(sentence) && !hasProvingAssertion(ledger, label)) {
      return null;
    }
  }
  return sentence;
}

function sanitizeList(lines: string[], ledger: EvidenceEntry[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    // Split on sentence boundaries so one banned sentence doesn't kill the
    // whole bullet; keep surviving sentences.
    const sentences = line.split(/(?<=[.!?])\s+/);
    const kept = sentences
      .map((s) => sanitizeSentence(s.trim(), ledger))
      .filter((s): s is string => !!s && s.length > 0);
    if (kept.length) out.push(kept.join(" "));
  }
  return out;
}

/** Server-owned status: LLM status is ignored entirely. Backend-authoritative
 *  per-area statuses (phase 8) win when present; the URL-set heuristic is
 *  only the legacy fallback. */
export function resolveStatus(area: string, coverage: Coverage): ReportStatus {
  const key = norm(area);
  const authoritative = coverage.areaStatuses?.[area] ?? coverage.areaStatuses?.[key];
  if (authoritative) {
    if (authoritative === "VERIFIED") return "Verified";
    if (authoritative === "PARTIALLY_VERIFIED") return "Partially verified";
    if (authoritative === "VISITED" || authoritative === "INSPECTED") return "Visited only";
    return "Planned/Unverified";
  }
  if (coverage.coveredAreas.some((a) => norm(a) === key)) return "Verified";
  if (coverage.visitedAreas.some((a) => norm(a) === key)) return "Visited only";
  return "Planned/Unverified";
}

function selectorObserved(locator: string, ledger: EvidenceEntry[]): boolean {
  const want = locator.trim();
  if (!want) return false;
  // Exact selector used by a tool (click/type/assert) counts as observed.
  if (ledger.some((e) => e.selector && e.selector.trim() === want)) return true;
  // Otherwise it must appear verbatim inside a snapshot/get_text excerpt.
  return ledger.some((e) => (e.excerpt ?? "").includes(want));
}

// Template placeholders such as {id}, {name}, <id> are never real evidence.
const TEMPLATE_PATTERN = /[{<][a-z_]*id[a-z_]*[}>]|\{name\}|\{slug\}/i;

/** Selectors successfully used this run, as locator rows. Every ledger entry
 *  is a successful tool execution, so these carry the evidence guarantee
 *  without any model invention. Shared by the structured and fallback paths
 *  so the locator table can never be emptier than what tools actually did. */
export function synthesizedLocators(ledger: EvidenceEntry[]): z.infer<typeof ReportLocatorSchema>[] {
  const seen = new Set<string>();
  const out: z.infer<typeof ReportLocatorSchema>[] = [];
  for (const entry of ledger) {
    const sel = (entry.selector ?? "").trim();
    if (!sel || seen.has(sel) || sel.includes("→")) continue;
    seen.add(sel);
    if (out.length >= 20) break;
    out.push({ element: sel, locator: sel, type: "observed selector" });
  }
  return out;
}

export function filterLocators(
  locators: z.infer<typeof ReportLocatorSchema>[],
  ledger: EvidenceEntry[]
): { kept: z.infer<typeof ReportLocatorSchema>[]; dropped: number } {
  const kept: z.infer<typeof ReportLocatorSchema>[] = [];
  let dropped = 0;
  for (const loc of locators) {
    if (TEMPLATE_PATTERN.test(loc.locator)) {
      dropped += 1;
      continue;
    }
    if (!selectorObserved(loc.locator, ledger)) {
      dropped += 1;
      continue;
    }
    kept.push(loc);
  }
  return { kept, dropped };
}

function esc(cell: string): string {
  return cell.replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}

function renderVerification(ledger: EvidenceEntry[], testRuns: TestRunSummary[]): string {
  const items: string[] = [];
  for (const a of ledger.filter((e) => e.tool === "test_assert")) {
    items.push(
      `- test_assert${a.assertKind ? ` ${a.assertKind}` : ""}${a.selector ? ` [${a.selector}]` : ""}: ${a.pass ? "PASS" : "FAIL"}${a.excerpt ? ` — ${a.excerpt.slice(0, 160)}` : ""}`
    );
  }
  for (const r of testRuns) {
    if (r.error) items.push(`- test run (${r.file || "all"}): ERROR — ${r.error.slice(0, 200)}`);
    else items.push(`- test run (${r.file || "all"}): ${r.passed ?? 0} passed, ${r.failed ?? 0} failed`);
  }
  if (!items.length) {
    items.push("- No deterministic assertions or test executions this run — verification is snapshot-only.");
  }
  return ["### Verification results", "", ...items].join("\n");
}

export function renderReportMarkdown(
  data: ReportData,
  coverage: Coverage,
  ledger: EvidenceEntry[],
  testRuns: TestRunSummary[] = []
): string {
  const lines: string[] = [];
  const titleComplete =
    coverage.requestedAreas.length > 0 &&
    coverage.requestedAreas.every((a) => coverage.coveredAreas.some((c) => norm(c) === norm(a)));

  // Phase 9: overall status is backend-owned; a token-limit stop can
  // never render as complete unless every area truly verified.
  const overall = coverage.overall ?? (titleComplete ? "COMPLETE" : "PARTIAL");
  lines.push(
    overall === "COMPLETE"
      ? "## Exploration report (complete)"
      : overall === "FAILED"
        ? "## Exploration report (failed)"
        : overall === "BLOCKED"
          ? "## Exploration report (blocked)"
          : "## Partial exploration"
  );
  lines.push("");
  lines.push(`**Overall status: ${overall}** (server-computed from evidence)`);
  lines.push("");
  const cleanSummary = sanitizeList([data.summary], ledger);
  lines.push(cleanSummary[0] ?? "Exploration finished. See areas table for verified evidence.");
  lines.push("");
  lines.push("| Area | Status | Features found | Evidence/Notes |");
  lines.push("| --- | --- | --- | --- |");

  // Every requested area gets a row even if the LLM omitted it — status is
  // always server-resolved, never model-resolved. The Evidence column is
  // server-built from the ledger; LLM evidence strings survive only when
  // quoted verbatim from it.
  const byArea = new Map(data.areas.map((a) => [norm(a.area), a]));
  const ledgerText = ledger
    .map((e) => `${e.excerpt ?? ""} ${e.selector ?? ""} ${e.url ?? ""} ${e.assertKind ?? ""}`)
    .join("\n")
    .toLowerCase();
  const rowNotes = (area: string, found: z.infer<typeof ReportAreaSchema> | undefined, requested: boolean): { status: ReportStatus; features: string; notes: string } => {
    // Requested areas: coverage is authoritative. Extras (areas the model
    // reported beyond the request): judged directly from ledger evidence, so
    // a generically-scoped run still credits real per-area evidence.
    const status = requested ? resolveStatus(area, coverage) : ledgerStatus(area, ledger);
    const features = found ? keptFeatures(found.features, ledger, ledgerText) : [];
    const llmEvidence = found
      ? sanitizeList(found.evidence, ledger).filter((e) => evidenceSupported(e, ledger))
      : [];
    const serverEvidence = evidenceForArea(area, ledger);
    const combined = [serverEvidence, ...llmEvidence].filter(Boolean).join("; ");
    const notes =
      status === "Verified"
        ? combined
        : status === "Partially verified"
          ? `Reached and inspected, but no passing assertion yet — not verified. ${combined}`.trim()
          : status === "Visited only"
            ? `Reached but not verified with snapshot/text/assert. ${combined}`.trim()
            : `Not covered this run. ${found?.gaps ?? ""}`.trim();
    return { status, features: features.join("; ") || "—", notes: notes || "—" };
  };
  for (const requested of coverage.requestedAreas) {
    const found = byArea.get(norm(requested));
    byArea.delete(norm(requested));
    const row = rowNotes(requested, found, true);
    lines.push(`| ${esc(requested)} | ${row.status} | ${esc(row.features)} | ${esc(row.notes)} |`);
  }
  // Extra areas the model reported beyond the request (kept, status resolved
  // from ledger evidence so they can still show Verified).
  for (const extra of byArea.values()) {
    const row = rowNotes(extra.area, extra, false);
    lines.push(`| ${esc(extra.area)} | ${row.status} | ${esc(row.features)} | ${esc(row.notes)} |`);
  }
  lines.push("");

  // Union: model-proposed locators plus every successfully-used selector from
  // the ledger (LLM labels win on duplicates). The table then always reflects
  // at least what the tools actually did — never emptier than the evidence.
  const mergedLocators = [...data.locators];
  for (const s of synthesizedLocators(ledger)) {
    if (!mergedLocators.some((m) => m.locator.trim() === s.locator)) mergedLocators.push(s);
  }
  const { kept, dropped } = filterLocators(mergedLocators, ledger);
  lines.push("### Key locators (observed this run only)");
  if (kept.length) {
    lines.push("");
    lines.push("| Element | Locator | Type |");
    lines.push("| --- | --- | --- |");
    for (const loc of kept) {
      lines.push(`| ${esc(loc.element)} | \`${esc(loc.locator)}\` | ${esc(loc.type)} |`);
    }
  } else {
    lines.push("");
    lines.push(
      dropped > 0
        ? `No locators survived evidence filtering (${dropped} dropped: not observed in this run's snapshots or tool calls).`
        : "No stable locators observed this run."
    );
  }
  lines.push("");
  lines.push(renderVerification(ledger, testRuns));
  lines.push("");
  lines.push("### Gaps & TBD");
  lines.push("");
  const missing = coverage.requestedAreas.filter(
    (a) => !coverage.coveredAreas.some((c) => norm(c) === norm(a))
  );
  const gaps = sanitizeList([...data.gaps, ...missing.map((m) => `${m}: not verified this run`)], ledger);
  // Server-raised gap: an area whose latest evidence looks like an error page.
  const errorAreas = [
    ...new Set(
      ledger
        .filter((e) => (e.excerpt ?? "").startsWith("[possible error page]"))
        .map((e) => areaForUrl(e.url))
        .filter((a): a is string => !!a)
    ),
  ];
  for (const a of errorAreas) {
    gaps.push(`${a}: latest snapshot looked like an error page — re-verify content`);
  }
  if (gaps.length) {
    for (const gap of new Set(gaps)) lines.push(`- ${gap}`);
  } else {
    lines.push("- None. All requested areas verified.");
  }
  return lines.join("\n");
}

/** Fallback when the structured LLM call fails: coverage + ledger only, zero model claims.
 *  Locator rows are synthesized from successfully-used selectors in the ledger
 *  (every ledger entry is a successful tool execution), so the evidence
 *  guarantee still holds without any model invention. */
export function renderFallbackReport(
  coverage: Coverage,
  browserActions: number,
  ledger: EvidenceEntry[] = [],
  testRuns: TestRunSummary[] = []
): string {
  return renderReportMarkdown(
    {
      summary: `Server-rendered fallback (${browserActions} browser actions). Structured summary unavailable; only server-verified coverage is shown.`,
      areas: [],
      locators: synthesizedLocators(ledger),
      gaps: [],
    },
    coverage,
    ledger,
    testRuns
  );
}
