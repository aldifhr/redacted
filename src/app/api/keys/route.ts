import { NextResponse } from "next/server";
import { z } from "zod";
import { guardApi } from "@/lib/api-guard";
import { deleteKey, listKeys, saveKey } from "@/lib/key-vault";
import { listModels } from "@/lib/provider-models";
import type { ProviderId } from "@/lib/providers";
import { assertPublicTarget } from "@/lib/ssrf";

export const maxDuration = 30;

const ProviderSchema = z.enum(["openai", "anthropic"]);

const SaveSchema = z.object({
  provider: ProviderSchema,
  apiKey: z.string().min(8).max(500),
  baseUrl: z.string().max(500).optional().default(""),
});

// GET /api/keys — daftar provider yang punya key tersimpan + fingerprint.
// Tidak pernah mengembalikan key mentah.
export async function GET(req: Request) {
  const blocked = guardApi(req, { scope: "keys", limit: 60 });
  if (blocked) return blocked;
  return NextResponse.json({ keys: listKeys() });
}

// POST /api/keys — simpan key LLM ke vault server.
// Key divalidasi dulu ke provider (daftar model); key yang salah tidak
// pernah masuk vault. Balasan: fingerprint sha256 (12 hex) untuk ditampilkan.
export async function POST(req: Request) {
  const blocked = guardApi(req, { scope: "keys", limit: 20 });
  if (blocked) return blocked;
  const parsed = SaveSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "provider and apiKey are required" }, { status: 400 });
  }
  const { provider, apiKey, baseUrl = "" } = parsed.data;
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
  try {
    const models = await listModels(provider as ProviderId, apiKey.trim(), baseUrl);
    if (!models.length) {
      return NextResponse.json({ error: "no models found" }, { status: 502 });
    }
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "key validation failed" },
      { status: 502 }
    );
  }
  const fingerprint = saveKey(provider as ProviderId, apiKey.trim());
  return NextResponse.json({ provider, fingerprint, saved: true });
}

// DELETE /api/keys — hapus key satu provider dari vault.
export async function DELETE(req: Request) {
  const blocked = guardApi(req, { scope: "keys", limit: 30 });
  if (blocked) return blocked;
  const parsed = z.object({ provider: ProviderSchema }).safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "provider is required" }, { status: 400 });
  }
  const removed = deleteKey(parsed.data.provider as ProviderId);
  return NextResponse.json({ provider: parsed.data.provider, removed });
}
