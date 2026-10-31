import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // anydoc ships a native (napi) binary — never bundle it, load at runtime.
  // OpenTelemetry pakai dynamic require internal — jangan di-bundle juga,
  // kalau tidak instrumentation-nya gagal patch modul Node.
  serverExternalPackages: [
    "@firecrawl/anydoc",
    "@opentelemetry/api",
    "@opentelemetry/sdk-node",
    "@opentelemetry/auto-instrumentations-node",
    "@opentelemetry/sdk-trace",
    "@opentelemetry/exporter-trace-otlp-http",
  ],
};

export default nextConfig;
