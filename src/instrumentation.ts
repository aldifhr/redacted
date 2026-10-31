// OpenTelemetry — dipanggil Next.js sekali saat server Node boot (dev & start).
//
// Env:
//   OTEL_SDK_DISABLED=true         → mati total (default: nyala)
//   OTEL_SERVICE_NAME              → nama service (default: playwright-tools-web-agent)
//   OTEL_EXPORTER_OTLP_ENDPOINT    → kalau di-set, span dikirim ke collector
//                                    (OTLP/HTTP, exporter baca env standar OTEL_*)
//   tanpa endpoint                 → ConsoleSpanExporter: span tercetak di
//                                    terminal dev, cocok buat cek wiring
export async function register() {
  // instrumentation.ts hanya untuk runtime Node; edge tidak dibebani.
  if (process.env.NEXT_RUNTIME === "edge") return;
  if (process.env.OTEL_SDK_DISABLED === "true") return;

  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  const { getNodeAutoInstrumentations } = await import("@opentelemetry/auto-instrumentations-node");
  const { ConsoleSpanExporter } = await import("@opentelemetry/sdk-trace");

  const hasCollector = Boolean(
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() ||
      process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim()
  );
  let traceExporter;
  if (hasCollector) {
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
    // Tanpa url: exporter resolve OTEL_EXPORTER_OTLP_* sendiri (termasuk
    // headers/auth lewat env standar).
    traceExporter = new OTLPTraceExporter();
  } else {
    traceExporter = new ConsoleSpanExporter();
  }

  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME?.trim() || "playwright-tools-web-agent",
    traceExporter,
    instrumentations: [
      getNodeAutoInstrumentations({
        // fs instrumentation spam sekali per file read — http/https/net
        // sudah cukup untuk melacak request dan panggilan keluar.
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
    ],
  });

  sdk.start();

  // Flush span yang masih buffered saat proses dimatikan (Ctrl+C, restart).
  // process sengaja diakses lewat globalThis: analisis Edge Runtime Next
  // menggugurkan file ini kalau melihat process.once langsung, padahal
  // register() hanya pernah jalan di runtime Node.
  const nodeProcess = (globalThis as unknown as {
    process?: { once?: (event: string, listener: () => void) => void };
  }).process;
  const shutdown = async () => {
    try {
      await sdk.shutdown();
    } catch {}
  };
  nodeProcess?.once?.("SIGINT", shutdown);
  nodeProcess?.once?.("SIGTERM", shutdown);
}
