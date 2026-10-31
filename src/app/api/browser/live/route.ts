import { guardApi } from "@/lib/api-guard";
import { startScreencast } from "@/lib/browser";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request) {
  const blocked = guardApi(req, { scope: "browser-live", limit: 30 });
  if (blocked) return blocked;

  const runId = new URL(req.url).searchParams.get("runId")?.trim() || undefined;
  if (runId && !/^[A-Za-z0-9_-]{1,80}$/.test(runId)) {
    return Response.json({ error: "invalid runId" }, { status: 400 });
  }

  const encoder = new TextEncoder();
  let stopScreencast: (() => Promise<void>) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {}
      };
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        } catch {
          closed = true;
        }
      };

      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ping ${Date.now()}\n\n`));
        } catch {
          closed = true;
        }
      }, 15_000);

      req.signal.addEventListener(
        "abort",
        () => {
          void stopScreencast?.();
          close();
        },
        { once: true }
      );

      try {
        stopScreencast = await startScreencast(
          runId,
          (frame) => send("frame", frame),
          req.signal,
          () => {
            send("end", {});
            close();
          }
        );
        send("open", { runId: runId ?? null });
      } catch (e) {
        send("error", {
          message: e instanceof Error ? e.message : "live view failed",
        });
        close();
      }
    },
    cancel() {
      void stopScreencast?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
