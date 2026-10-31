import { NextResponse } from "next/server";
import { z } from "zod";
import { generateObject } from "ai";
import { getModel, PROVIDERS, type ProviderId } from "@/lib/providers";
import { resolveKey } from "@/lib/key-vault";
import { listFacts, saveFact } from "@/lib/memory";
import { guardApi } from "@/lib/api-guard";

const ConsolidateSchema = z.object({
  provider: z.enum(["openai", "anthropic"]),
  model: z.string().max(120).optional(),
  // opsional: kosong/marker → key dari vault server
  apiKey: z.string().max(500).optional().default(""),
  baseUrl: z.string().max(500).optional().default(""),
  messages: z
    .array(z.object({ role: z.string().max(20), content: z.string().max(15000) }))
    .min(1)
    .max(40),
});

// POST /api/memory/consolidate — extract durable facts from recent chats
// into MEMORY.md. Secret-looking facts are rejected by saveFact; duplicates
// are skipped. Returns what was saved vs skipped.
export async function POST(req: Request) {
  const blocked = guardApi(req, { scope: "memory-consolidate", limit: 10 });
  if (blocked) return blocked;
  const parsed = ConsolidateSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "provider and messages are required" }, { status: 400 });
  }
  const { provider, model, apiKey, baseUrl, messages } = parsed.data;
  const chosenModel = model || PROVIDERS[provider as ProviderId].models[0];

  let llm: ReturnType<typeof getModel>;
  try {
    llm = getModel(provider as ProviderId, chosenModel, resolveKey(provider, apiKey), baseUrl);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "model configuration failed" },
      { status: 400 }
    );
  }

  const transcript = messages
    .map((m) => `${m.role}: ${m.content.slice(0, 2000)}`)
    .join("\n---\n")
    .slice(0, 15000);
  const existing = listFacts();

  try {
    const { object } = await generateObject({
      model: llm,
      schema: z.object({
        facts: z
          .array(z.string().max(200))
          .max(10)
          .describe("Durable facts worth remembering across sessions"),
      }),
      system:
        "Extract durable user facts from this chat transcript: preferences, do/don't rules, public demo-site facts, important URLs, robust locators that worked. " +
        "One fact per item, one line each, no secrets (never passwords, API keys, tokens). " +
        "Skip ephemeral chatter, tool outputs, and anything already covered. " +
        (existing.length ? `Already known (do not repeat):\n${existing.map((f) => `- ${f}`).join("\n")}` : "No facts known yet."),
      prompt: `Transcript:\n${transcript}`,
    });

    const saved: string[] = [];
    const skipped: { fact: string; reason: string }[] = [];
    for (const fact of object.facts) {
      const clean = fact.trim().replace(/\s+/g, " ");
      if (!clean) continue;
      try {
        saveFact(clean);
        saved.push(clean);
      } catch (e) {
        skipped.push({ fact: clean.slice(0, 80), reason: e instanceof Error ? e.message : "rejected" });
      }
    }
    return NextResponse.json({ saved, skipped, total: listFacts().length });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "consolidation failed" },
      { status: 502 }
    );
  }
}
