import { test, expect } from "@playwright/test";
import { sanitizeFile, casesFile, saveCases, mergeCases, readCases, saveCaseResults, readCasesWithResults, deleteSpec } from "../src/lib/specs";
import { parseExplorationScope } from "../src/lib/exploration";
import { saveFact } from "../src/lib/memory";
import { assertPublicTarget } from "../src/lib/ssrf";
import { isReadOnlyCommand } from "../src/lib/browser";
import { getBrowserTools } from "../src/lib/agent";
import { rateLimit, tryEnter, leave } from "../src/lib/rate-limit";
import { requireAuth } from "../src/lib/auth";

// Pure unit tests for agent lib helpers (no browser, no file writes:
// every assertion below either validates input or expects a throw
// before any disk mutation happens).

test("sanitizeFile accepts plain names and appends the suffix", () => {
  expect(sanitizeFile("login-saucedemo")).toBe("login-saucedemo.spec.ts");
  expect(sanitizeFile("login-saucedemo.spec.ts")).toBe("login-saucedemo.spec.ts");
});

test("sanitizeFile neutralizes traversal via basename, rejects bad extensions", () => {
  // basename() strips directories, so traversal attempts collapse to a safe name
  expect(sanitizeFile("../evil")).toBe("evil.spec.ts");
  expect(sanitizeFile("a/b.spec.ts")).toBe("b.spec.ts");
  expect(() => sanitizeFile("spec.js")).toThrow();
  expect(() => sanitizeFile("")).toThrow();
});

test("casesFile maps a spec name to its .cases.json artifact", () => {
  expect(casesFile("login-saucedemo.spec.ts")).toBe("login-saucedemo.cases.json");
  expect(casesFile("login-saucedemo")).toBe("login-saucedemo.cases.json");
});

test("exploration scope extracts areas, priority, and continuation", () => {
  expect(parseExplorationScope("Continue https://example.com login and checkout, critical, max 8 browser actions")).toEqual({
    site: "https://example.com",
    areas: ["login", "checkout"],
    priority: "critical",
    maxActions: 8,
    continue: true,
  });
});

test("exploration scope does not treat a handoff mention as re-entry", () => {
  expect(parseExplorationScope("Explore login and report the next area for continue").continue).toBe(false);
});

test("incremental case merge replaces duplicate ids and preserves prior areas", async () => {
  const file = "tmp-merge.spec.ts";
  await saveCases(file, [
    { id: "TC-001", area: "Login", type: "Positive", title: "valid login", preconditions: "", testData: "", steps: ["open page"], expected: "dashboard", priority: "High", severity: "High" },
  ]);
  try {
    await mergeCases(file, [
      { id: "TC-001", area: "Login", type: "Positive", title: "valid login", preconditions: "", testData: "", steps: ["open page", "submit form"], expected: "dashboard", priority: "High", severity: "High" },
      { id: "TC-002", area: "Checkout", type: "Positive", title: "pay order", preconditions: "", testData: "", steps: ["open checkout"], expected: "confirmation", priority: "High", severity: "High" },
    ]);
    const cases = await readCases(file);
    expect(cases).toHaveLength(2);
    expect(cases.find((item) => item.id === "TC-001")?.steps).toEqual(["open page", "submit form"]);
    expect(cases.find((item) => item.id === "TC-002")?.area).toBe("Checkout");
  } finally {
    await deleteSpec(file).catch(() => null);
    const { deleteCases } = await import("../src/lib/specs");
    await deleteCases(file);
  }
});

test("saveFact rejects secrets before touching disk", () => {
  expect(() => saveFact("api-key: sk-abcdefgh12345678")).toThrow();
  expect(() => saveFact("db password: supersecretvalue123")).toThrow();
});

test("ssrf guard blocks loopback, private, and metadata targets", async () => {
  await expect(assertPublicTarget("http://localhost:3000")).rejects.toThrow(/loopback/i);
  await expect(assertPublicTarget("http://127.0.0.1/")).rejects.toThrow(/loopback|private/i);
  await expect(assertPublicTarget("http://169.254.169.254/")).rejects.toThrow(/metadata|private/i);
  await expect(assertPublicTarget("http://[::1]/")).rejects.toThrow(/loopback|private/i);
});

test("ssrf guard allows loopback only with explicit opt-in", async () => {
  const url = await assertPublicTarget("http://localhost:11434", { allowLocal: true });
  expect(url.hostname).toBe("localhost");
  // metadata stays blocked even with opt-in
  await expect(assertPublicTarget("http://169.254.169.254/", { allowLocal: true })).rejects.toThrow();
});

test("isReadOnlyCommand separates readers from executors", () => {
  expect(isReadOnlyCommand("ls tests")).toBe(true);
  expect(isReadOnlyCommand("cat package.json")).toBe(true);
  expect(isReadOnlyCommand("grep -r foo src")).toBe(true);
  expect(isReadOnlyCommand("node script.js")).toBe(false);
  expect(isReadOnlyCommand("npm test")).toBe(false);
  expect(isReadOnlyCommand("npx playwright test")).toBe(false);
  expect(isReadOnlyCommand("ls; rm -rf /")).toBe(false);
  expect(isReadOnlyCommand("")).toBe(false);
});

test("bash without approval channel denies executors, allows readers", async () => {
  const tools = getBrowserTools();
  const bash = tools.browser_bash as unknown as { execute: (input: unknown) => Promise<unknown> };
  await expect(bash.execute({ command: "npx something-evil" })).rejects.toThrow(/denied/i);
  // Allowlisted but not read-only: still denied when no human is in the loop.
  await expect(bash.execute({ command: "node -e 'console.log(1)'" })).rejects.toThrow(/denied/i);
  // `echo` is a cmd.exe builtin with no spawnable exe on Windows, so the
  // read-only happy path can only be exercised where a real binary exists.
  if (process.platform !== "win32") {
    const out = (await bash.execute({ command: "echo hi" })) as { stdout: string };
    expect(out.stdout.trim()).toBe("hi");
  }
});

test("rate limiter allows then rejects over the limit", () => {
  const key = `test-${Date.now()}-${Math.random()}`;
  expect(rateLimit(key, 2, 60_000)).toBeNull();
  expect(rateLimit(key, 2, 60_000)).toBeNull();
  const rejected = rateLimit(key, 2, 60_000);
  expect(rejected).not.toBeNull();
  expect(rejected?.status).toBe(429);
});

test("concurrent slots guard expensive endpoints", () => {
  const slot = `test-slot-${Date.now()}`;
  expect(tryEnter(slot, 1)).toBe(true);
  expect(tryEnter(slot, 1)).toBe(false);
  leave(slot);
  expect(tryEnter(slot, 1)).toBe(true);
  leave(slot);
});

test("manual results round-trip with validation", async () => {  const file = "tmp-manual.spec.ts";
  await saveCases(file, [
    { id: "TC-001", area: "Login", type: "Positive", title: "valid login", preconditions: "", testData: "", steps: ["open page"], expected: "dashboard", priority: "High", severity: "High" },
  ]);
  try {
    await expect(saveCaseResults(file, [{ id: "TC-999", status: "PASS" }])).rejects.toThrow(/unknown case id/i);
    await expect(saveCaseResults(file, [{ id: "TC-001", status: "MAYBE" }])).rejects.toThrow(/invalid status/i);
    const saved = await saveCaseResults(file, [{ id: "TC-001", status: "pass", actual: "dashboard shown" }]);
    expect(saved.summary.PASS).toBe(1);
    const merged = await readCasesWithResults(file);
    expect(merged[0].result.status).toBe("PASS");
    expect(merged[0].result.actual).toBe("dashboard shown");
  } finally {
    await deleteSpec(file).catch(() => null);
    const { deleteCases } = await import("../src/lib/specs");
    await deleteCases(file);
  }
});

test("auth is open without token, enforced with token", () => {
  expect(requireAuth(new Request("http://x/"))).toBeNull();
  process.env.APP_TOKEN = "secret-token";
  try {
    expect(requireAuth(new Request("http://x/"))?.status).toBe(401);
    expect(
      requireAuth(new Request("http://x/", { headers: { Authorization: "Bearer secret-token" } }))
    ).toBeNull();
    expect(
      requireAuth(new Request("http://x/", { headers: { Authorization: "Bearer wrong" } }))?.status
    ).toBe(401);
  } finally {
    delete process.env.APP_TOKEN;
  }
});

test("rowsToCases maps headers, splits steps, dedupes ids", async () => {
  const { rowsToCases, suggestFileName } = await import("../src/lib/case-import");
  const headers = ["ID", "Area", "Type", "Title", "Test Data", "Test Step", "Expected Result", "Priority"];
  const out = rowsToCases(headers, [
    ["LGN001", "Login", "Positive", "valid login", "standard_user", "1. Input user 2. Input pass 3. Click login", "dashboard", "High"],
    ["LGN001", "Login", "Negative", "dup id", "", "1. Do x", "error", ""],
    ["", "", "", "", "", "", "", ""],
  ]);
  expect(out).toHaveLength(2);
  expect(out[0].steps).toEqual(["Input user", "Input pass", "Click login"]);
  expect(out[0].priority).toBe("High");
  expect(out[1].id).not.toBe("LGN001");
  expect(out[1].priority).toBe("Medium");
  const fb = rowsToCases(["Title", "Expected Result"], [["t", "e"]], { areaFallback: "Cart", idPrefix: "CART" });
  expect(fb[0].id).toBe("CART-001");
  expect(fb[0].area).toBe("Cart");
  expect(suggestFileName("TestCase_SauceDemo.xlsx")).toBe("TestCase_SauceDemo.spec.ts");
  await expect(async () => rowsToCases(["Foo", "Bar"], [["a", "b"]])).rejects.toThrow();
});

test("parseCsv handles quotes, embedded commas/newlines, CRLF and BOM", async () => {
  const { parseCsv } = await import("../src/lib/spreadsheet");
  expect(parseCsv('id,title\r\n1,"a, b"\r\n2,"line1\nline2"\r\n3,"say ""hi"""\r\n')).toEqual([
    ["id", "title"],
    ["1", "a, b"],
    ["2", "line1\nline2"],
    ["3", 'say "hi"'],
  ]);
  expect(parseCsv("\uFEFFid,title\n1,x")).toEqual([
    ["id", "title"],
    ["1", "x"],
  ]);
  expect(parseCsv("")).toEqual([]);
});

test("readSpreadsheet reads csv, xlsx and rejects legacy .xls", async () => {
  const { readSpreadsheet } = await import("../src/lib/spreadsheet");
  const asFile = (bytes: Uint8Array, name: string) =>
    new File([bytes as unknown as BlobPart], name);

  const csv = await readSpreadsheet(
    asFile(new TextEncoder().encode("ID,Title\nTC-1,login\n"), "cases.csv")
  );
  expect(csv).toHaveLength(1);
  expect(csv[0].name).toBe("CSV");
  expect(csv[0].rows[0]).toEqual(["ID", "Title"]);
  expect(csv[0].rows[1]).toEqual(["TC-1", "login"]);

  const { loadExcelJs } = await import("../src/lib/spreadsheet");
  const ExcelJS = await loadExcelJs();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Login");
  ws.addRow(["ID", "Title", "Steps"]);
  ws.addRow(["TC-001", "valid login", "1. Open page\n2. Click login"]);
  ws.addRow([42, true, null]);
  const xlsx = await readSpreadsheet(asFile(new Uint8Array(await wb.xlsx.writeBuffer()), "cases.xlsx"));
  expect(xlsx).toHaveLength(1);
  expect(xlsx[0].name).toBe("Login");
  expect(xlsx[0].rows[0]).toEqual(["ID", "Title", "Steps"]);
  expect(xlsx[0].rows[1]).toEqual(["TC-001", "valid login", "1. Open page\n2. Click login"]);
  expect(xlsx[0].rows[2]).toEqual(["42", "true", ""]);

  // OLE2 magic — the format xlsx@0.18.5 accepted and exceljs deliberately does not.
  const ole2 = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
  await expect(readSpreadsheet(asFile(ole2, "legacy.xls"))).rejects.toThrow(/legacy \.xls/);
});

test("readSpreadsheet import path produces cases end-to-end", async () => {
  const { readSpreadsheet } = await import("../src/lib/spreadsheet");
  const { rowsToCases } = await import("../src/lib/case-import");
  const csv = "ID,Area,Title,Steps,Expected Result\nLGN-1,Login,valid login,1. Open page 2. Click login,dashboard\n";
  const sheets = await readSpreadsheet(
    new File([new TextEncoder().encode(csv)] as unknown as BlobPart[], "cases.csv")
  );
  const [head, ...rows] = sheets[0].rows;
  const cases = rowsToCases(head, rows, { areaFallback: "Sheet", idPrefix: "SH" });
  expect(cases).toHaveLength(1);
  expect(cases[0].id).toBe("LGN-1");
  expect(cases[0].steps).toEqual(["Open page", "Click login"]);
});
