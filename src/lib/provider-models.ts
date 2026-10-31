import { DEFAULT_BASE_URLS, type ProviderId } from "./providers";

// Server-only: daftar model live dari provider. Dipakai /api/models (buat UI)
// dan /api/keys (validasi key sebelum disimpan ke vault).

export async function listOpenAI(baseUrl: string, apiKey: string): Promise<string[]> {
  const base = (baseUrl || DEFAULT_BASE_URLS.openai).replace(/\/+$/, "");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const msg = await r.text().catch(() => "");
      throw new Error(`OpenAI /models: ${r.status} ${msg.slice(0, 160)}`);
    }
    const j = (await r.json()) as { data?: { id: string }[] };
    const ids = (j.data ?? []).map((d) => d.id).filter(Boolean);
    // dahulukan model chat populer, lalu sisanya alfabetis (tanpa cap: gateway
    // OpenAI-compatible sering punya ratusan model).
    const prio = ["gpt-4o", "gpt-4o-mini", "o4-mini", "o3-mini", "gpt-4.1"];
    return [...new Set([...prio.filter((p) => ids.includes(p)), ...ids.sort()])];
  } finally {
    clearTimeout(t);
  }
}

export async function listAnthropic(baseUrl: string, apiKey: string): Promise<string[]> {
  const base = (baseUrl || DEFAULT_BASE_URLS.anthropic).replace(/\/+$/, "");
  const ids: string[] = [];
  let afterId = "";
  // Anthropic paginates /models; keep going until has_more is false.
  for (let page = 0; page < 10; page += 1) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    try {
      const qs = new URLSearchParams({ limit: "1000" });
      if (afterId) qs.set("after_id", afterId);
      const r = await fetch(`${base}/models?${qs.toString()}`, {
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        signal: ctrl.signal,
      });
      if (!r.ok) {
        const msg = await r.text().catch(() => "");
        throw new Error(`Anthropic /models: ${r.status} ${msg.slice(0, 160)}`);
      }
      const j = (await r.json()) as {
        data?: { id: string }[];
        has_more?: boolean;
        last_id?: string;
      };
      ids.push(...(j.data ?? []).map((d) => d.id).filter(Boolean));
      if (!j.has_more || !j.last_id || j.last_id === afterId) break;
      afterId = j.last_id;
    } finally {
      clearTimeout(t);
    }
  }
  return [...new Set(ids)];
}

export function listModels(provider: ProviderId, apiKey: string, baseUrl: string): Promise<string[]> {
  return provider === "openai"
    ? listOpenAI(baseUrl, apiKey)
    : listAnthropic(baseUrl, apiKey);
}
