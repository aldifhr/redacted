import { lookup } from "node:dns/promises";

// Server-only SSRF guard shared by browser navigation and model base URLs.
// Default policy blocks loopback/private/link-local/metadata targets.
// Callers that legitimately need local endpoints (e.g. Ollama on localhost)
// pass { allowLocal: true }; cloud metadata endpoints stay blocked always.

export type SsrfOptions = {
  allowLocal?: boolean;
};

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = parts;
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    a >= 224 || // multicast + reserved + broadcast
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // 192.0.0.0/24, TEST-NET-1
    (a === 198 && (b === 18 || b === 19)) || // benchmarking 198.18/15
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    (a === 169 && b === 254)
  );
}

function isPrivateIPv6(ip: string): boolean {
  const low = ip.toLowerCase();
  return (
    low === "::1" ||
    low === "::" ||
    low.startsWith("fe80:") ||
    low.startsWith("fec0:") ||
    low.startsWith("fc") ||
    low.startsWith("fd")
  );
}

// Unwrap IPv4-mapped IPv6 (::ffff:127.0.0.1 and the hex form
// ::ffff:7f00:1) so mapped loopback/private addresses cannot slip past the
// IPv6 check.
function unwrapMappedIPv6(ip: string): string {
  const low = ip.toLowerCase();
  const dotted = low.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const hex = low.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return ip;
}

function isBlockedAddress(address: string, family: number, allowLocal: boolean): boolean {
  const unwrapped = family === 6 ? unwrapMappedIPv6(address) : address;
  const fam = unwrapped.includes(".") && !unwrapped.includes(":") ? 4 : family;
  const privateAddr = fam === 4 ? isPrivateIPv4(unwrapped) : isPrivateIPv6(unwrapped);
  // Cloud metadata endpoints are never allowed, even with allowLocal.
  const metadata =
    unwrapped === "169.254.169.254" ||
    unwrapped.toLowerCase() === "fd00:ec2::254" ||
    unwrapped.toLowerCase() === "metadata.google.internal";
  if (metadata) return true;
  return !allowLocal && privateAddr;
}

function isLoopbackHostname(host: string): boolean {
  const h = host.toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || h === "[::1]";
}

function isMetadataHostname(host: string): boolean {
  return host.toLowerCase() === "metadata.google.internal";
}

// Resolve + validate. Returns the parsed URL when the target is allowed.
export async function assertPublicTarget(rawUrl: string, options?: SsrfOptions): Promise<URL> {
  const allowLocal = options?.allowLocal === true;
  let target = rawUrl.trim();
  if (!/^https?:\/\//i.test(target)) target = "https://" + target;
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    throw new Error("invalid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("only http(s) URLs are allowed");
  }
  const host = parsed.hostname.toLowerCase();
  if (isMetadataHostname(host)) {
    throw new Error("navigation to cloud metadata endpoints is not allowed");
  }
  if (!allowLocal && isLoopbackHostname(host)) {
    throw new Error("navigation to loopback addresses is not allowed");
  }
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new Error(`cannot resolve host '${host}'`);
  }
  if (addresses.some(({ address, family }) => isBlockedAddress(address, family, allowLocal))) {
    throw new Error(
      allowLocal
        ? `navigation to cloud metadata endpoints is not allowed (${host})`
        : `navigation to private/internal addresses is not allowed (${host})`
    );
  }
  return parsed;
}
