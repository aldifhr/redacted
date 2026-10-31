import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";

// Server-only: opt-in bearer auth, enforced by guardApi.
// - APP_TOKEN unset (default local use) → open, no friction.
// - APP_TOKEN set → routes that call guardApi require `Authorization: Bearer <token>`.
//   /api/chat/stream and /api/docs/convert never call guardApi, so they skip
//   this check too — keep the server on loopback (see package.json -H flag).
export function requireAuth(req: Request): NextResponse | null {
  const token = process.env.APP_TOKEN?.trim();
  if (!token) return null;
  const header = req.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  // Hash both sides so comparison is constant-time and never leaks the
  // configured token's length.
  const expected = createHash("sha256").update(token).digest();
  const actual = createHash("sha256").update(presented).digest();
  if (timingSafeEqual(expected, actual)) return null;
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}
