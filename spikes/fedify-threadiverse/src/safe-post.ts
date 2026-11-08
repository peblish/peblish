// POST to an inbox URL that a remote server chose (its actor document says
// where its inbox is), without letting that URL reach internal services.
//
// - https only; the host's addresses are resolved once and every one must be
//   public, so the address checked is the address connected to (no DNS
//   rebinding window between check and connect);
// - redirects are never followed (a 3xx counts as a refused delivery);
// - a hard timeout, and at most MAX_RESPONSE_BYTES of the response are read.
//
// The lab runs every peer on 192.88.99.0/24, a special-purpose block, so
// FEDDIT_LAB_CIDR names the one range allowed in addition to public space.
// Loopback, RFC 1918 and the rest stay blocked even in the lab.
import { lookup } from "node:dns";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";

const MAX_RESPONSE_BYTES = 64 * 1024;

// IANA special-purpose registries (RFC 6890 and updates).
//
// No `::ffff:0:0/96` (IPv4-mapped) rule belongs in the IPv6 list: Node's
// BlockList tests an IPv4 address against every IPv6 rule through its mapped
// form, so that one rule blocked all of IPv4. Mapped addresses are unmapped
// and checked as IPv4 instead (see `classify`).
const BLOCKED = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) BLOCKED.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 127], ["64:ff9b::", 96], ["100::", 64], ["2001::", 23],
  ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) BLOCKED.addSubnet(network, prefix, "ipv6");

const LAB = new BlockList();
const labCidr = process.env.FEDDIT_LAB_CIDR;
if (labCidr) {
  const [network, prefix] = labCidr.split("/");
  if (network && prefix) LAB.addSubnet(network, Number(prefix), "ipv4");
}

export class BlockedDestinationError extends Error {}

const IPV4_MAPPED = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/;

/** The address's family, with an IPv4-mapped IPv6 address (::ffff:a.b.c.d) reduced to the IPv4 a.b.c.d. */
function classify(address: string): { address: string; type: "ipv4" | "ipv6" } | null {
  const family = isIP(address);
  if (family === 4) return { address, type: "ipv4" };
  if (family !== 6) return null;
  // The URL parser gives every spelling of a mapped address one form, ::ffff:xxxx:xxxx.
  const mapped = IPV4_MAPPED.exec(new URL(`http://[${address.replace(/%.*$/, "")}]`).hostname);
  if (!mapped) return { address, type: "ipv6" };
  const [high, low] = [parseInt(mapped[1]!, 16), parseInt(mapped[2]!, 16)];
  return { address: `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`, type: "ipv4" };
}

export function isAllowedAddress(address: string): boolean {
  const ip = classify(address);
  if (!ip) return false;
  if (LAB.check(ip.address, ip.type)) return true;
  return !BLOCKED.check(ip.address, ip.type);
}

/** dns.lookup that refuses when any address of the host is not allowed. */
const guardedLookup: typeof lookup = ((hostname: string, options: unknown, callback: unknown) => {
  const done = (typeof options === "function" ? options : callback) as (
    error: Error | null,
    address?: string | { address: string; family: number }[],
    family?: number,
  ) => void;
  const wantsAll = typeof options === "object" && options != null && "all" in options && options.all === true;
  lookup(hostname, { all: true }, (error, addresses) => {
    if (error) return done(error);
    const bad = addresses.find((entry) => !isAllowedAddress(entry.address));
    if (bad || addresses.length === 0) {
      return done(new BlockedDestinationError(`${hostname} resolves to a blocked address ${bad?.address ?? "(none)"}`));
    }
    if (wantsAll) return done(null, addresses);
    done(null, addresses[0]!.address, addresses[0]!.family);
  });
}) as typeof lookup;

export interface SafeResponse {
  status: number;
  body: string;
  location?: string;
}

export async function safePost(
  url: string,
  headers: Headers,
  body: string,
  timeoutMs: number,
): Promise<SafeResponse> {
  const target = new URL(url);
  if (target.protocol !== "https:") throw new BlockedDestinationError(`refusing ${target.protocol} inbox ${url}`);
  const host = target.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !isAllowedAddress(host)) throw new BlockedDestinationError(`blocked address ${host}`);
  const outgoing: Record<string, string> = { "content-length": String(Buffer.byteLength(body)) };
  headers.forEach((value, name) => {
    outgoing[name] = value;
  });
  return await new Promise<SafeResponse>((resolve, reject) => {
    const req = request(
      target,
      {
        method: "POST",
        headers: outgoing,
        lookup: guardedLookup,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size <= MAX_RESPONSE_BYTES) chunks.push(chunk);
          else res.destroy();
        });
        const settle = () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            location: res.headers.location,
          });
        res.on("end", settle);
        res.on("close", settle);
      },
    );
    const timer = setTimeout(() => req.destroy(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
    req.on("timeout", () => req.destroy(new Error(`timed out after ${timeoutMs} ms`)));
    req.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.on("close", () => clearTimeout(timer));
    req.end(body);
  });
}
