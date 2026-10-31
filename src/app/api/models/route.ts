import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveKey } from "@/lib/key-vault";
import { listModels } from "@/lib/provider-models";
import { assertPublicTarget } from "@/lib/ssrf";
import { guardApi } from "@/lib/api-guard";

export const maxDuration = 30;

// POST /api/models — daftar model live. apiKey opsional: kalau kosong (atau
// marker "vault"), key diambil dari vault server.
export async function POST(req: Request) {
  const blocked = guardApi(req, { scope: "models", limit: 30 });
  if (blocked) return blocked;
  const parsed = z.object({
    provider: z.enum(["openai", "anthropic"]),
    apiKey: z.string().max(500).optional().default(""),
    baseUrl: z.string().max(500).optional().default(""),
  }).safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "provider is required" }, { status: 400 });
  }
  try {
    const { provider, apiKey, baseUrl = "" } = parsed.data;
    // The server forwards the user's key to this URL, so validate the target:
    // must be http(s), resolvable, and never a cloud metadata endpoint.
    // Private/loopback hosts stay allowed (local Ollama-style gateways).
    if (baseUrl.trim()) {
      if (baseUrl.trim().length > 500) {
        return NextResponse.json({ error: "base URL is too long" }, { status: 400 });
      }
      try {
        await assertPublicTarget(baseUrl.trim(), { allowLocal: true });
      } catch (e) {
        return NextResponse.json(
          { error: e instanceof Error ? e.message : "invalid base URL" },
          { status: 400 }
        );
      }
    }
    const models = await listModels(provider, resolveKey(provider, apiKey), baseUrl);
    if (!models.length) {
      return NextResponse.json({ error: "no models found" }, { status: 502 });
    }
    return NextResponse.json({ models, source: "live" });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed to load models" },
      { status: 502 }
    );
  }
}
