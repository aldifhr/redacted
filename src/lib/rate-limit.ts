import { NextResponse } from "next/server";

// Server-only: sliding-window rate limits + concurrent-run caps.
// In-memory (single instance). For multi-instance deployments put a
// reverse proxy with rate limiting in front.

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

function prune() {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now > bucket.resetAt) buckets.delete(key);
  }
  if (buckets.size > 5000) {
    // Trim the oldest windows down to a safe size instead of one per request.
    const excess = buckets.size - 4000;
    let removed = 0;
    for (const key of buckets.keys()) {
      if (removed >= excess) break;
      buckets.delete(key);
      removed += 1;
    }
  }
}

// Fixed-window counter. Returns null when allowed, or a 429 response.
export function rateLimit(key: string, limit: number, windowMs: number): NextResponse | null {
  prune();
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return null;
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    return NextResponse.json(
      { error: "rate limit exceeded, try again later" },
      { status: 429, headers: { "Retry-After": String(Math.ceil((bucket.resetAt - now) / 1000)) } }
    );
  }
  return null;
}

export function clientKey(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() || "local";
  return ip.slice(0, 64);
}

// Concurrent-run guard for expensive endpoints (chat streams, test runs).
const inFlight = new Map<string, number>();

export function tryEnter(slot: string, max: number): boolean {
  const current = inFlight.get(slot) ?? 0;
  if (current >= max) return false;
  inFlight.set(slot, current + 1);
  return true;
}

export function leave(slot: string) {
  const current = inFlight.get(slot) ?? 0;
  const next = Math.max(0, current - 1);
  // Delete at zero so finished slots never accumulate forever.
  if (next === 0) inFlight.delete(slot);
  else inFlight.set(slot, next);
}
