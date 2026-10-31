import { trace, SpanStatusCode, type Attributes, type Span } from "@opentelemetry/api";

// Server-only: helper tipis di atas OTel API. Kalau SDK tidak diregistrasi
// (test, edge), tracer otomatis no-op — pemanggil tidak perlu branching.

const tracer = trace.getTracer("playwright-tools-web-agent", "1.0.0");

// Satu span untuk satu unit kerja. Error di-record ke span lalu dilempar
// ulang, jadi jejak error tetap kelihatan di trace tanpa mengubah alur kode.
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  attributes?: Attributes
): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    try {
      if (attributes) span.setAttributes(attributes);
      return await fn(span);
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      span.end();
    }
  });
}
