// Client-side spreadsheet reader: XLSX via ExcelJS, everything else via a
// small RFC 4180 CSV parser. Replaces xlsx@0.18.5, which reached end of life
// on npm with two unpatched CVEs (prototype pollution, ReDoS) in XLSX.read.

export type SheetRows = { name: string; rows: string[][] };

// Total rows read per sheet — same cap the old reader applied via sheetRows.
const MAX_ROWS = 200;

type ExcelJsModule = typeof import("exceljs");

// exceljs ships CommonJS: under `import()` its Workbook lands on `.default`,
// and the browser bundle can nest that once more. Unwrap whichever shape we get.
export async function loadExcelJs(): Promise<ExcelJsModule> {
  let candidate: unknown = await import("exceljs");
  for (let depth = 0; depth < 3; depth += 1) {
    const scope = candidate as { Workbook?: unknown; default?: unknown };
    if (typeof scope?.Workbook === "function") return candidate as ExcelJsModule;
    if (!scope?.default || typeof scope.default !== "object") break;
    candidate = scope.default;
  }
  throw new Error("exceljs failed to load");
}

// Legacy OLE2 compound file (.xls, .xlsm of the 97-2003 kind).
const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0];
const ZIP_MAGIC = [0x50, 0x4b];

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  return magic.every((b, i) => bytes[i] === b);
}

// ExcelJS hands back cell values as objects for formulas/hyperlinks/rich text;
// collapse every shape to the string the importer expects.
function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return isoDate(value);
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.richText)) {
      return (obj.richText as { text?: string }[]).map((run) => run.text ?? "").join("");
    }
    if ("result" in obj) return cellText(obj.result);
    if ("text" in obj) return cellText(obj.text);
    if ("error" in obj) return String(obj.error);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

// Midnight timestamps read as a bare date, otherwise keep the time.
function isoDate(d: Date): string {
  const iso = d.toISOString();
  return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
}

export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }
    if (char === '"') {
      quoted = true;
      i += 1;
      continue;
    }
    if (char === ",") {
      endField();
      i += 1;
      continue;
    }
    if (char === "\r" || char === "\n") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      endRow();
      i += 1;
      continue;
    }
    field += char;
    i += 1;
  }
  if (field.length || row.length) endRow();
  return rows;
}

async function readXlsx(bytes: Uint8Array): Promise<SheetRows[]> {
  const ExcelJS = await loadExcelJs();
  const workbook = new ExcelJS.Workbook();
  // The browser build takes the bytes straight from File; typings say Buffer.
  // Call through the object so `this` stays bound (xlsx.load reads its xfs).
  const xlsxIo = workbook.xlsx as unknown as { load: (data: Uint8Array) => Promise<void> };
  await xlsxIo.load(bytes.slice());
  const sheets: SheetRows[] = [];
  for (const sheet of workbook.worksheets.slice(0, 10)) {
    const rows: string[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      if (rows.length >= MAX_ROWS) return;
      rows.push((row.values as unknown[]).slice(1).map((v) => cellText(v)));
    });
    if (!rows.length) continue;
    // ExcelJS drops trailing empty cells; pad so every row matches the header width.
    const width = Math.max(...rows.map((r) => r.length));
    for (const row of rows) while (row.length < width) row.push("");
    sheets.push({ name: sheet.name || `Sheet${sheets.length + 1}`, rows });
  }
  return sheets;
}

export async function readSpreadsheet(file: File): Promise<SheetRows[]> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (startsWith(bytes, OLE2_MAGIC)) {
    throw new Error(`${file.name} is a legacy .xls file — re-save it as .xlsx or .csv`);
  }
  if (startsWith(bytes, ZIP_MAGIC)) {
    const sheets = await readXlsx(bytes);
    if (!sheets.length) throw new Error("Workbook has no sheets");
    return sheets;
  }
  const text = new TextDecoder("utf-8").decode(bytes);
  if (!text.trim()) throw new Error("Spreadsheet is empty");
  return [{ name: "CSV", rows: parseCsv(text).slice(0, MAX_ROWS) }];
}
