// Export helpers for assistant messages: Markdown tables -> XLSX sheets,
// message -> Markdown file, message -> printable HTML (user picks PDF in the
// print dialog).

export type ParsedTable = { headers: string[]; rows: string[][] };

export function parseMarkdownTables(content: string): ParsedTable[] {
  const lines = content.split("\n");
  const tables: ParsedTable[] = [];
  let i = 0;
  const isSep = (line: string) =>
    /^\s*\|?[\s:|-]+\|?[\s|:-]*$/.test(line) && line.includes("-");
  const splitRow = (line: string) =>
    line
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((c) => c.trim());
  while (i < lines.length) {
    const line = lines[i];
    if (line.includes("|") && i + 1 < lines.length && isSep(lines[i + 1])) {
      const headers = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      if (headers.length > 1 || rows.length) tables.push({ headers, rows });
      continue;
    }
    i += 1;
  }
  return tables;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inlineMd(s: string): string {
  return escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, "<code>$1</code>");
}

// Minimal Markdown -> HTML for printing (headings, lists, tables, code, prose).
export function messageToHtml(content: string): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let i = 0;
  const isSep = (line: string) =>
    /^\s*\|?[\s:|-]+\|?[\s|:-]*$/.test(line) && line.includes("-");
  const splitRow = (line: string) =>
    line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  let inList = false;
  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    if (line.includes("|") && i + 1 < lines.length && isSep(lines[i + 1])) {
      closeList();
      const headers = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      out.push(
        "<table><thead><tr>" +
          headers.map((h) => `<th>${inlineMd(h)}</th>`).join("") +
          "</tr></thead><tbody>" +
          rows.map((r) => `<tr>${r.map((c) => `<td>${inlineMd(c)}</td>`).join("")}</tr>`).join("") +
          "</tbody></table>"
      );
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${inlineMd(heading[2])}</h${level}>`);
    } else if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inlineMd(line.replace(/^\s*[-*]\s+/, ""))}</li>`);
    } else if (/^\s*\d+\.\s+/.test(line)) {
      closeList();
      out.push(`<p>${inlineMd(line.trim())}</p>`);
    } else if (!line.trim()) {
      closeList();
    } else {
      closeList();
      out.push(`<p>${inlineMd(line)}</p>`);
    }
    i += 1;
  }
  closeList();
  return out.join("\n");
}

export async function downloadXlsx(baseName: string, tables: ParsedTable[]) {
  const { loadExcelJs } = await import("@/lib/spreadsheet");
  const ExcelJS = await loadExcelJs();
  const wb = new ExcelJS.Workbook();
  tables.forEach((t, i) => {
    const ws = wb.addWorksheet(`Table ${i + 1}`);
    ws.addRow(t.headers);
    t.rows.forEach((r) => ws.addRow(r));
    t.headers.forEach((h, ci) => {
      const width = Math.min(60, Math.max(h.length, ...t.rows.map((r) => (r[ci] ?? "").length)) + 2);
      ws.getColumn(ci + 1).width = width;
    });
  });
  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${baseName}.xlsx`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function downloadMarkdown(baseName: string, content: string) {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${baseName}.md`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function printMessage(title: string, htmlBody: string) {
  const doc = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:800px;margin:32px auto;padding:0 16px;color:#111;font-size:13px;line-height:1.6}
table{border-collapse:collapse;width:100%;margin:12px 0;font-size:12px}
th,td{border:1px solid #999;padding:6px 8px;text-align:left;vertical-align:top}
th{background:#eee}h1{font-size:20px}h2{font-size:17px}h3{font-size:14px}
code{background:#f0f0f0;padding:1px 4px;border-radius:4px;font-size:12px}
ul{padding-left:20px}
</style></head><body>${htmlBody}<script>onload=()=>{print();}</script></body></html>`;
  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  document.body.appendChild(iframe);
  const win = iframe.contentWindow;
  if (!win) {
    iframe.remove();
    return;
  }
  win.document.open();
  win.document.write(doc);
  win.document.close();
  // The onload print() fires inside the frame; remove it afterwards.
  win.addEventListener("afterprint", () => iframe.remove());
  setTimeout(() => iframe.remove(), 60_000);
}
