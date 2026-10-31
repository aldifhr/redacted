import { promises as fs } from "node:fs";
import { join, basename, relative } from "node:path";
import { execFile } from "node:child_process";

// Server-only: kelola file test Playwright di ./tests + menjalankannya.

const DIR = join(process.cwd(), "tests");
const MAX_CONTENT = 200_000;
const RUN_TIMEOUT_MS = 100_000;

export type SpecInfo = {
  file: string;
  kb: number;
  updatedAt: number;
};

export type Attachment = {
  name: string;
  path: string; // relatif ke root proyek
  contentType: string;
};

export type SpecResult = {
  title: string;
  file: string;
  status: "passed" | "failed" | "skipped" | "timedOut" | string;
  durationMs: number;
  error: string;
  attachments: Attachment[];
};

export type RunArtifact = {
  kind: "trace" | "video" | "screenshot" | string;
  name: string;
  path: string;
};

export type RunSummary = {
  ok: boolean;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  results: SpecResult[];
  error?: string;
  artifacts?: RunArtifact[];
  lastFailed?: boolean;
};

export type QaPlanDocument = {
  projectName: string;
  testerName: string;
  date: string;
  version: string;
  objective: string;
  inScope: string[];
  outOfScope: string[];
  testStrategy: string[];
  deliverables: string[];
  environment: { key: string; value: string }[];
  roles: { role: string; name: string; responsibility: string }[];
  schedule: { event: string; startDate: string; endDate: string }[];
  risks: { risk: string; mitigation: string }[];
  approval: { name: string; role: string; signature: string }[];
};

export async function savePlanDocument(file: string, plan: QaPlanDocument) {
  const safe = planName(file);
  if (!/^[a-zA-Z0-9-_]+(\/[a-zA-Z0-9-_]+)?$/.test(safe)) throw new Error("invalid test plan filename");
  const bullet = (items: string[]) => items.length ? items.map((item) => `- ${item}`).join("\n") : "- TBD";
  const table = (headers: string[], rows: string[][]) => [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
  const content = [
    `# ${plan.projectName || "QA Test Plan"}`,
    "",
    "## 1. Project Information",
    table(["Field", "Value"], [["Project Name", plan.projectName], ["Tester Name", plan.testerName], ["Date", plan.date], ["Version", plan.version]]),
    "",
    "## 2. Objective",
    plan.objective,
    "",
    "## 3. Scope of Testing",
    "### In Scope",
    bullet(plan.inScope),
    "",
    "### Out of Scope",
    bullet(plan.outOfScope),
    "",
    "## 4. Test Strategy",
    bullet(plan.testStrategy),
    "",
    "## 5. Test Deliverables",
    bullet(plan.deliverables),
    "",
    "## 6. Test Environment",
    table(["Environment", "Value"], plan.environment.map((item) => [item.key, item.value])),
    "",
    "## 7. Roles & Responsibilities",
    table(["Role", "Name", "Responsibility"], plan.roles.map((item) => [item.role, item.name, item.responsibility])),
    "",
    "## 8. Schedule",
    table(["Event", "Start Date", "End Date"], plan.schedule.map((item) => [item.event, item.startDate, item.endDate])),
    "",
    "## 9. Risk & Mitigation",
    table(["Risk", "Mitigation"], plan.risks.map((item) => [item.risk, item.mitigation])),
    "",
    "## 10. Approval",
    table(["Name", "Role", "Signature"], plan.approval.map((item) => [item.name, item.role, item.signature])),
    "",
  ].join("\n");
  await ensureDirFor(safe);
  const saved = `${safe}.md`;
  await fs.writeFile(join(DIR, saved), content, "utf-8");
  const tbdCount = (content.match(/\bTBD\b/gi) ?? []).length;
  const missingFields = [
    ["projectName", plan.projectName], ["testerName", plan.testerName], ["date", plan.date],
    ["version", plan.version], ["objective", plan.objective], ["inScope", plan.inScope.length],
    ["outOfScope", plan.outOfScope.length], ["testStrategy", plan.testStrategy.length],
    ["deliverables", plan.deliverables.length], ["environment", plan.environment.length],
    ["roles", plan.roles.length], ["schedule", plan.schedule.length], ["risks", plan.risks.length],
    ["approval", plan.approval.length],
  ].filter(([, value]) => !value).map(([field]) => field);
  return { saved, sections: 10, projectName: plan.projectName, qualityGate: { complete: tbdCount === 0 && missingFields.length === 0, tbdCount, missingFields, fileWritten: true } };
}

export function sanitizeFile(name: string): string {
  const base = basename(String(name ?? "").trim());
  if (!/^[a-zA-Z0-9-_]+(\.spec\.ts)?$/.test(base)) {
    throw new Error(
      "invalid filename — use letters, numbers, hyphens, underscores, and the .spec.ts suffix"
    );
  }
  return base.endsWith(".spec.ts") ? base : `${base}.spec.ts`;
}

// Scoped path: "file" or "group/file". Groups keep tests/ tidy per site
// or feature (e.g. "qabrains-ecommerce/login.spec.ts"). Each segment is
// strictly validated; "..", ".", and deeper nesting are rejected.
export function sanitizePath(name: string): string {
  const parts = String(name ?? "")
    .trim()
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 1 || parts.length > 2) {
    throw new Error("invalid path — use file.spec.ts or group/file.spec.ts");
  }
  if (parts.length === 2) {
    const [scope, file] = parts;
    if (!/^[a-zA-Z0-9-_]+$/.test(scope)) {
      throw new Error("invalid group name — use letters, numbers, hyphens, underscores");
    }
    return `${scope}/${sanitizeFile(file)}`;
  }
  return sanitizeFile(parts[0]);
}

export function planName(file: string): string {
  const rel = sanitizePath(String(file ?? "").trim().replace(/\.md$/i, ""));
  const base = basename(rel).replace(/\.spec\.ts$/, "") || "test-plan";
  const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
  return dir ? `${dir}/${base}` : base;
}

async function ensureDirFor(rel: string) {
  const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
  await fs.mkdir(dir ? join(DIR, dir) : DIR, { recursive: true });
}

export async function listSpecs(): Promise<SpecInfo[]> {
  await fs.mkdir(DIR, { recursive: true });
  const files = await walkSpecs(DIR);
  const infos = await Promise.all(
    files.map(async (file) => {
      const st = await fs.stat(join(DIR, file));
      return {
        file,
        kb: Math.max(1, Math.round(st.size / 1024)),
        updatedAt: st.mtimeMs,
      };
    })
  );
  return infos.sort((a, b) => b.updatedAt - a.updatedAt);
}

async function walkSpecs(dir: string, prefix = ""): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (/^[a-zA-Z0-9-_]+$/.test(entry.name)) {
        out.push(...(await walkSpecs(join(dir, entry.name), rel)));
      }
    } else if (entry.name.endsWith(".spec.ts")) {
      out.push(rel);
    }
  }
  return out;
}

export async function readSpec(file: string): Promise<string> {
  const safe = sanitizePath(file);
  return fs.readFile(join(DIR, safe), "utf-8");
}

export async function saveSpec(
  file: string,
  content: string
): Promise<{ saved: string; lines: number }> {
  const safe = sanitizePath(file);
  if (!content || !content.trim()) throw new Error("test content cannot be empty");
  if (content.length > MAX_CONTENT) throw new Error("test content is too large");
  if (!content.includes("@playwright/test")) {
    throw new Error("spec must import from @playwright/test");
  }
  if (!/\btest\s*\(/.test(content)) {
    throw new Error("spec must contain at least one test() call");
  }
  await ensureDirFor(safe);
  await fs.writeFile(join(DIR, safe), content.trim() + "\n", "utf-8");
  return { saved: safe, lines: content.trim().split("\n").length };
}

export type TestCase = {
  id: string;
  area: string;
  type: string;
  title: string;
  preconditions: string;
  testData: string;
  steps: string[];
  expected: string;
  priority: "High" | "Medium" | "Low";
  severity: "High" | "Medium" | "Low";
};

export function casesFile(file: string): string {
  const safe = sanitizePath(file);
  return safe.replace(/\.spec\.ts$/, ".cases.json");
}

export async function readCases(file: string): Promise<TestCase[]> {
  const path = join(DIR, casesFile(file));
  try {
    const raw = await fs.readFile(path, "utf-8");
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (c): c is TestCase =>
        !!c && typeof (c as TestCase).id === "string" && typeof (c as TestCase).title === "string"
    );
  } catch {
    return [];
  }
}

export async function saveCases(
  file: string,
  cases: TestCase[]
): Promise<{ saved: string; count: number; ids: string[]; areas: Record<string, number>; qualityGate: { complete: boolean; tbdCount: number; fileWritten: boolean } }> {
  if (!Array.isArray(cases) || !cases.length) {
    throw new Error("test cases cannot be empty");
  }
  if (cases.length > 50) throw new Error("maximum 50 cases");
  const clean = cases.map((c) => ({
    id: String(c.id ?? "").slice(0, 20),
    area: String(c.area ?? "").slice(0, 60),
    type: String(c.type ?? "Positive").slice(0, 20),
    title: String(c.title ?? "").slice(0, 160),
    preconditions: String(c.preconditions ?? "").slice(0, 300),
    testData: String(c.testData ?? "").slice(0, 300),
    steps: (Array.isArray(c.steps) ? c.steps : []).map((s) => String(s).slice(0, 300)).slice(0, 20),
    expected: String(c.expected ?? "").slice(0, 300),
    priority: ["High", "Medium", "Low"].includes(c.priority) ? c.priority : "Medium",
    severity: ["High", "Medium", "Low"].includes(c.severity) ? c.severity : "Medium",
  }));
  if (clean.some((c) => !c.id || !c.title || !c.steps.length || !c.expected)) {
    throw new Error("each case requires an id, title, steps, and expected result");
  }
  const name = casesFile(file);
  await ensureDirFor(name);
  await fs.writeFile(join(DIR, name), JSON.stringify(clean, null, 2) + "\n", "utf-8");
  const areas = clean.reduce<Record<string, number>>((summary, testCase) => {
    summary[testCase.area] = (summary[testCase.area] ?? 0) + 1;
    return summary;
  }, {});
  const serialized = JSON.stringify(clean);
  const tbdCount = (serialized.match(/\bTBD\b/gi) ?? []).length;
  return {
    saved: name,
    count: clean.length,
    ids: clean.map((testCase) => testCase.id),
    areas,
    qualityGate: { complete: tbdCount === 0, tbdCount, fileWritten: true },
  };
}

export async function mergeCases(
  file: string,
  incoming: TestCase[]
) {
  const existing = await readCases(file);
  const merged = [...existing];
  const existingKeys = new Set(existing.map((testCase) => testCase.id || testCase.title.toLowerCase()));
  let addedCount = 0;
  let updatedCount = 0;
  for (const testCase of incoming) {
    const key = testCase.id || testCase.title.toLowerCase();
    const index = merged.findIndex((current) => (current.id || current.title.toLowerCase()) === key);
    if (index >= 0) {
      merged[index] = testCase;
      updatedCount += 1;
    } else if (!existingKeys.has(key)) {
      merged.push(testCase);
      existingKeys.add(key);
      addedCount += 1;
    }
  }
  return {
    ...(await saveCases(file, merged)),
    addedCount,
    updatedCount,
    totalCount: merged.length,
  };
}

export async function deleteSpec(file: string): Promise<{ deleted: string }> {
  const safe = sanitizePath(file);
  await fs.unlink(join(DIR, safe));
  return { deleted: safe };
}

export async function deleteCases(file: string) {
  try {
    await fs.unlink(join(DIR, casesFile(file)));
  } catch {}
  try {
    await fs.unlink(join(DIR, resultsFile(file)));
  } catch {}
}

export type CaseStatus = "UNTESTED" | "PASS" | "FAIL" | "BLOCKED" | "SKIPPED";

export type CaseResult = {
  id: string;
  status: CaseStatus;
  actual: string;
  executedAt: number;
};

export type CaseWithResult = TestCase & { result: CaseResult };

const STATUSES: CaseStatus[] = ["UNTESTED", "PASS", "FAIL", "BLOCKED", "SKIPPED"];

export function resultsFile(file: string): string {
  const safe = sanitizePath(file);
  return safe.replace(/\.spec\.ts$/, ".results.json");
}

function emptyResult(id: string): CaseResult {
  return { id, status: "UNTESTED", actual: "", executedAt: 0 };
}

export async function readCaseResults(file: string): Promise<Record<string, CaseResult>> {
  const path = join(DIR, resultsFile(file));
  try {
    const raw = await fs.readFile(path, "utf-8");
    const obj = JSON.parse(raw) as unknown;
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
    const out: Record<string, CaseResult> = {};
    for (const [id, r] of Object.entries(obj as Record<string, unknown>)) {
      const rec = r as Partial<CaseResult>;
      out[id] = {
        id,
        status: STATUSES.includes(rec.status as CaseStatus) ? (rec.status as CaseStatus) : "UNTESTED",
        actual: String(rec.actual ?? "").slice(0, 500),
        executedAt: Number(rec.executedAt) || 0,
      };
    }
    return out;
  } catch {
    return {};
  }
}

// Manual execution tracking: record PASS/FAIL/BLOCKED/SKIPPED per case id.
// Unknown ids are rejected so results always line up with saved cases.
export async function saveCaseResults(
  file: string,
  results: { id: string; status: string; actual?: string }[]
): Promise<{
  saved: string;
  recorded: number;
  summary: Record<CaseStatus, number>;
  changes: { id: string; title: string; from: string; to: string }[];
}> {
  if (!Array.isArray(results) || !results.length) {
    throw new Error("results cannot be empty");
  }
  if (results.length > 50) throw new Error("maximum 50 results at once");
  const cases = await readCases(file);
  if (!cases.length) throw new Error("no saved cases for this file — use test_plan first");
  const known = new Set(cases.map((c) => c.id));
  const now = Date.now();
  const current = await readCaseResults(file);
  const changes: { id: string; title: string; from: string; to: string }[] = [];
  for (const r of results) {
    const id = String(r.id ?? "");
    if (!known.has(id)) throw new Error(`unknown case id: ${id || "(empty)"}`);
    const status = String(r.status ?? "").toUpperCase() as CaseStatus;
    if (!STATUSES.includes(status) || status === "UNTESTED") {
      throw new Error(`invalid status for ${id}: use PASS, FAIL, BLOCKED, or SKIPPED`);
    }
    const from = current[id]?.status ?? "UNTESTED";
    if (from !== status) {
      changes.push({
        id,
        title: cases.find((c) => c.id === id)?.title ?? id,
        from,
        to: status,
      });
    }
    current[id] = {
      id,
      status,
      actual: String(r.actual ?? "").slice(0, 500),
      executedAt: now,
    };
  }
  const name = resultsFile(file);
  await ensureDirFor(name);
  await fs.writeFile(join(DIR, name), JSON.stringify(current, null, 2) + "\n", "utf-8");
  const summary = Object.values(current).reduce(
    (acc, r) => {
      acc[r.status] += 1;
      return acc;
    },
    { UNTESTED: 0, PASS: 0, FAIL: 0, BLOCKED: 0, SKIPPED: 0 } as Record<CaseStatus, number>
  );
  return { saved: name, recorded: results.length, summary, changes };
}

export async function readCasesWithResults(file: string): Promise<CaseWithResult[]> {
  const [cases, results] = await Promise.all([readCases(file), readCaseResults(file)]);
  return cases.map((c) => ({ ...c, result: results[c.id] ?? emptyResult(c.id) }));
}

type JsonSuite = {
  title: string;
  file: string;
  specs?: JsonSpec[];
  suites?: JsonSuite[];
};
type JsonSpec = {
  title: string;
  file: string;
  tests?: {
    results?: {
      status: string;
      duration?: number;
      errors?: { message?: string }[];
      error?: { message?: string };
      attachments?: { name?: string; path?: string; contentType?: string }[];
    }[];
  }[];
};

function collect(suites: JsonSuite[] | undefined, out: SpecResult[]) {
  for (const s of suites ?? []) {
    for (const spec of s.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const r = t.results?.[0];
        out.push({
          title: spec.title,
          file: spec.file ? relative(DIR, spec.file) : "",
          status: r?.status ?? "unknown",
          durationMs: Math.round(r?.duration ?? 0),
          error: (
            r?.errors?.[0]?.message ??
            r?.error?.message ??
            ""
          ).slice(0, 800),
          attachments: (r?.attachments ?? [])
            .filter((a) => a.path)
            .map((a) => ({
              name: a.name ?? basename(a.path as string),
              path: relative(process.cwd(), a.path as string),
              contentType: a.contentType ?? "",
            })),
        });
      }
    }
    collect(s.suites, out);
  }
}

const LAST_RUN = join(DIR, ".last-run.json");
const RUN_LOG = join(DIR, ".run-log.json");
const RUN_LOG_MAX = 100;

export type RunLogEntry = {
  id: string;
  at: number;
  scope: string | null; // filename, or null = all
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  ok: boolean;
  results: {
    file: string;
    title: string;
    status: string;
    durationMs: number;
  }[];
};

export async function loadLastRun(): Promise<Record<string, RunSummary>> {
  try {
    const raw = await fs.readFile(LAST_RUN, "utf-8");
    const map = JSON.parse(raw) as Record<string, RunSummary>;
    return map && typeof map === "object" ? map : {};
  } catch {
    return {};
  }
}

export async function clearRunLog(): Promise<{ cleared: boolean }> {
  try {
    await fs.unlink(RUN_LOG);
  } catch {}
  return { cleared: true };
}

export async function loadRunLog(): Promise<RunLogEntry[]> {  try {
    const raw = await fs.readFile(RUN_LOG, "utf-8");
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (e): e is RunLogEntry => !!e && typeof (e as RunLogEntry).id === "string"
    );
  } catch {
    return [];
  }
}

function emptySummary(): RunSummary {
  return { ok: true, passed: 0, failed: 0, skipped: 0, durationMs: 0, results: [] };
}

// Simpan hasil run agar kolom Status di tabel tetap terisi walau run-nya
// dari chat/agent (bukan dari tombol halaman /tests).
export async function recordRun(file: string | null, summary: RunSummary) {
  try {
    await fs.mkdir(DIR, { recursive: true });
    const map = await loadLastRun();
    if (file) {
      map[file] = summary;
    } else {
      // reset entri file yang ikut run ini agar hitungan tidak dobel
      const seen = new Set(summary.results.map((t) => t.file || "__all__"));
      for (const f of seen) map[f] = emptySummary();
      for (const t of summary.results) {
        const f = t.file || "__all__";
        const s = map[f];
        s.results.push(t);
        s.durationMs += t.durationMs;
        if (t.status === "passed") s.passed += 1;
        else if (t.status === "skipped") s.skipped += 1;
        else s.failed += 1;
        s.ok = s.failed === 0;
      }
      map["__all__"] = summary;
    }
    await fs.writeFile(LAST_RUN, JSON.stringify(map), "utf-8");
    // log riwayat (untuk halaman /runs + deteksi flaky)
    try {
      const log = await loadRunLog();
      log.push({
        id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        at: Date.now(),
        scope: file,
        passed: summary.passed,
        failed: summary.failed,
        skipped: summary.skipped,
        durationMs: summary.durationMs,
        ok: summary.ok,
        results: summary.results.map((t) => ({
          file: t.file,
          title: t.title,
          status: t.status,
          durationMs: t.durationMs,
        })),
      });
      await fs.writeFile(
        RUN_LOG,
        JSON.stringify(log.slice(-RUN_LOG_MAX)),
        "utf-8"
      );
    } catch {}
  } catch {}
}

let runInFlight = false;

// Fail fast: typecheck target specs before spending up to 100s on a run.
// Returns combined compiler output, or null when clean.
async function typecheckSpecs(files: string[]): Promise<string | null> {
  if (!files.length) return null;
  const tsc = join(process.cwd(), "node_modules", "typescript", "bin", "tsc");
  return new Promise((resolvePromise) => {
    execFile(
      "node",
      [
        tsc,
        "--noEmit",
        "--skipLibCheck",
        "--target", "es2017",
        "--module", "esnext",
        "--moduleResolution", "bundler",
        "--lib", "esnext,dom",
        ...files.map((f) => join(DIR, f)),
      ],
      { cwd: process.cwd(), timeout: 60_000, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) {
          resolvePromise(null);
          return;
        }
        const out = `${stdout}\n${stderr}`.trim().slice(-1500);
        resolvePromise(out || "typecheck failed with no output");
      }
    );
  });
}

async function collectRunArtifacts(since: number): Promise<RunArtifact[]> {
  const out: RunArtifact[] = [];
  const root = join(process.cwd(), "test-results");
  const walk = async (dir: string, depth: number) => {
    if (depth > 4 || out.length >= 40) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= 40) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      const ext = entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase();
      const kind =
        ext === ".zip" && entry.name.startsWith("trace")
          ? "trace"
          : ext === ".webm"
            ? "video"
            : [".png", ".jpg", ".jpeg"].includes(ext)
              ? "screenshot"
              : "";
      if (!kind) continue;
      try {
        const stat = await fs.stat(full);
        if (stat.mtimeMs < since - 2_000) continue;
        out.push({ kind, name: entry.name, path: relative(process.cwd(), full) });
      } catch {}
    }
  };
  await walk(root, 0);
  return out;
}

export function runSpec(
  file?: string,
  options?: { lastFailed?: boolean }
): Promise<RunSummary> {
  let startedAt = 0;
  if (runInFlight) {
    return Promise.resolve({
      ok: false,
      passed: 0,
      failed: 0,
      skipped: 0,
      durationMs: 0,
      results: [],
      error: "another test run is already in progress — try again shortly",
    });
  }
  return new Promise((resolve) => {
    const finish = (summary: RunSummary) => {
      runInFlight = false;
      if (!startedAt) {
        resolve(summary);
        return;
      }
      void collectRunArtifacts(startedAt).then((artifacts) =>
        resolve({ ...summary, artifacts, lastFailed: !!options?.lastFailed })
      );
    };
    let safe: string | null = null;
    try {
      if (file) safe = sanitizePath(file);
    } catch (e) {
      finish({
        ok: false,
        passed: 0,
        failed: 0,
        skipped: 0,
        durationMs: 0,
        results: [],
        error: e instanceof Error ? e.message : "invalid filename",
      });
      return;
    }
    // Claim the lock synchronously so a second call made in the same tick
    // still sees it while the first is awaiting readdir/typecheck.
    runInFlight = true;
    void (async () => {
      // NOTE: runInFlight is already true here (set synchronously above),
      // so concurrent callers get the busy error even during typecheck.
      let targets: string[];
      try {
        await fs.mkdir(DIR, { recursive: true });
        targets = safe ? [safe] : await walkSpecs(DIR);
      } catch (e) {
        finish({
          ok: false,
          passed: 0,
          failed: 0,
          skipped: 0,
          durationMs: 0,
          results: [],
          error: e instanceof Error ? e.message : "cannot list specs",
        });
        return;
      }
      if (!targets.length) {
        finish({
          ok: false,
          passed: 0,
          failed: 0,
          skipped: 0,
          durationMs: 0,
          results: [],
          error: "no .spec.ts files found — save a spec with test_save first",
        });
        return;
      }
      const typeError = await typecheckSpecs(targets);
      if (typeError) {
        finish({
          ok: false,
          passed: 0,
          failed: 0,
          skipped: 0,
          durationMs: 0,
          results: [],
          error: `spec validation failed:\n${typeError}`,
        });
        return;
      }
      const bin = join(process.cwd(), "node_modules", ".bin", "playwright");
      // filter CLI Playwright itu regex substring — tanpa anchor,
      // "saucedemo.spec.ts" ikut menjalankan "login-saucedemo.spec.ts".
      // Escape + anchor ke path separator agar exact 1 file.
      const args = safe
        ? ["test", `/tests/${safe.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "--reporter=json"]
        : ["test", "--reporter=json"];
      args.push("--trace=retain-on-failure", "--video=retain-on-failure");
      if (options?.lastFailed) args.push("--last-failed");
      const started = startedAt = Date.now();
      execFile(
        bin,
        args,
        { cwd: process.cwd(), timeout: RUN_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const durationMs = Date.now() - started;
          try {
            const j = JSON.parse(stdout) as {
              stats?: {
                expected?: number;
                unexpected?: number;
                skipped?: number;
              };
              suites?: JsonSuite[];
            };
            const results: SpecResult[] = [];
            collect(j.suites, results);
            const passed = j.stats?.expected ?? results.filter((r) => r.status === "passed").length;
            const failed = j.stats?.unexpected ?? results.filter((r) => !["passed", "skipped"].includes(r.status)).length;
            finish({
              ok: !err && failed === 0,
              passed,
              failed,
              skipped: j.stats?.skipped ?? 0,
              durationMs,
              results,
              error: err
                ? `exit ${String((err as unknown as { code?: unknown }).code ?? "?")}: ${stderr.slice(-500)}`
                : undefined,
            });
          } catch {
            finish({
              ok: false,
              passed: 0,
              failed: 0,
              skipped: 0,
              durationMs,
              results: [],
              error: `failed to parse results: ${stdout.slice(-800)} ${stderr.slice(-300)}`,
            });
          }
        }
      );
    })().catch((e: unknown) => {
      finish({
        ok: false,
        passed: 0,
        failed: 0,
        skipped: 0,
        durationMs: 0,
        results: [],
        error: e instanceof Error ? e.message : "test run crashed",
      });
    });
  });
}
