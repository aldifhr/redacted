import { NextResponse } from "next/server";

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
  if (presented && presented.length === token.length) {
    let diff = 0;
    for (let i = 0; i < token.length; i++) {
      diff |= token.charCodeAt(i) ^ presented.charCodeAt(i);
    }
    if (diff === 0) return null;
  }
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}
