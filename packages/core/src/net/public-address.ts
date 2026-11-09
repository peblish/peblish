import { isIP } from 'node:net';

// The one public-address predicate: every outbound request to a host a person or a peer
// chose (safeFetch: federation delivery, actor fetches, link previews, the remote-media
// proxy) must pass it, for every address the host resolves to. There is no bypass here; a
// test that needs a private address injects its own resolver and predicate into
// createSafeFetch (net/fetch.ts), which product code never imports.
//
// The ranges are IANA's special-purpose registries (RFC 6890 and updates) plus what the
// IPv6 address space registry leaves unallocated. Node's net.BlockList is not used: it tests
// an IPv4 address against IPv6 rules through the mapped form, so one `::ffff:0:0/96` rule
// blocks all of IPv4 (the Phase 0 spike's defect).

type Range = { readonly name: string; readonly cidr: string; readonly rfc: string };

/** Blocked IPv4 ranges. */
export const ipv4Ranges: readonly Range[] = [
  { name: 'this-network', cidr: '0.0.0.0/8', rfc: 'RFC 791' },
  { name: 'private-10', cidr: '10.0.0.0/8', rfc: 'RFC 1918' },
  { name: 'cgnat', cidr: '100.64.0.0/10', rfc: 'RFC 6598' },
  { name: 'loopback', cidr: '127.0.0.0/8', rfc: 'RFC 1122' },
  { name: 'link-local', cidr: '169.254.0.0/16', rfc: 'RFC 3927' },
  { name: 'private-172', cidr: '172.16.0.0/12', rfc: 'RFC 1918' },
  { name: 'ietf-protocol-assignments', cidr: '192.0.0.0/24', rfc: 'RFC 6890' },
  { name: 'documentation-1', cidr: '192.0.2.0/24', rfc: 'RFC 5737' },
  { name: '6to4-relay-anycast', cidr: '192.88.99.0/24', rfc: 'RFC 7526' },
  { name: 'private-192', cidr: '192.168.0.0/16', rfc: 'RFC 1918' },
  { name: 'benchmarking', cidr: '198.18.0.0/15', rfc: 'RFC 2544' },
  { name: 'documentation-2', cidr: '198.51.100.0/24', rfc: 'RFC 5737' },
  { name: 'documentation-3', cidr: '203.0.113.0/24', rfc: 'RFC 5737' },
  { name: 'multicast', cidr: '224.0.0.0/4', rfc: 'RFC 5771' },
  // Class E, with the limited broadcast 255.255.255.255/32 (RFC 919) at its end.
  { name: 'reserved', cidr: '240.0.0.0/4', rfc: 'RFC 1112' },
];

/** IPv6 ranges judged by the IPv4 address inside them. */
export const ipv6EmbeddingRanges: readonly Range[] = [
  { name: 'ipv4-mapped', cidr: '::ffff:0:0/96', rfc: 'RFC 4291' },
  // DNS64 on an IPv6-only host answers a real IPv4 peer with an address in this block.
  { name: 'nat64', cidr: '64:ff9b::/96', rfc: 'RFC 6052' },
];

/** Blocked IPv6 ranges. */
export const ipv6Ranges: readonly Range[] = [
  { name: 'unspecified', cidr: '::/128', rfc: 'RFC 4291' },
  { name: 'loopback', cidr: '::1/128', rfc: 'RFC 4291' },
  // Deprecated, never a destination; blocked whole instead of judged by the IPv4 inside.
  { name: 'ipv4-compatible', cidr: '::/96', rfc: 'RFC 4291' },
  { name: 'nat64-local-use', cidr: '64:ff9b:1::/48', rfc: 'RFC 8215' },
  { name: 'discard', cidr: '100::/64', rfc: 'RFC 6666' },
  { name: 'ietf-protocol-assignments', cidr: '2001::/23', rfc: 'RFC 2928' },
  { name: 'teredo', cidr: '2001::/32', rfc: 'RFC 4380' },
  { name: 'documentation', cidr: '2001:db8::/32', rfc: 'RFC 3849' },
  { name: '6to4', cidr: '2002::/16', rfc: 'RFC 3056' },
  { name: 'documentation-3fff', cidr: '3fff::/20', rfc: 'RFC 9637' },
  { name: 'unique-local', cidr: 'fc00::/7', rfc: 'RFC 4193' },
  { name: 'link-local', cidr: 'fe80::/10', rfc: 'RFC 4291' },
  { name: 'site-local', cidr: 'fec0::/10', rfc: 'RFC 3879' },
  { name: 'multicast', cidr: 'ff00::/8', rfc: 'RFC 4291' },
];

/** Global unicast (RFC 4291, IANA 2000::/3): the only IPv6 space allocated to hosts. Anything outside it is refused too. */
const globalUnicast = '2000::/3';

type Block = { readonly bits: number; readonly prefix: number; readonly network: bigint };
const asBlock = ({ cidr }: Range, bits: 32 | 128): Block => {
  const [address = '', prefix = ''] = cidr.split('/');
  const value = bits === 32 ? parseIPv4(address) : parseIPv6(address);
  if (value === null) throw new TypeError(`bad range ${cidr}`);
  return { bits, prefix: Number(prefix), network: BigInt(value) };
};
const contains = (block: Block, value: bigint) =>
  value >> BigInt(block.bits - block.prefix) === block.network >> BigInt(block.bits - block.prefix);

function parseIPv4(text: string): number | null {
  if (isIP(text) !== 4) return null;
  return text.split('.').reduce((n, octet) => n * 256 + Number(octet), 0);
}

function parseIPv6(text: string): bigint | null {
  // A zone ("fe80::1%eth0") only ever names a local interface.
  if (isIP(text) !== 6 || text.includes('%')) return null;
  let body = text;
  if (body.includes('.')) {
    // A dotted IPv4 tail (::ffff:1.2.3.4) becomes its two hexadecimal groups.
    const split = body.lastIndexOf(':') + 1;
    const tail = parseIPv4(body.slice(split));
    if (tail === null) return null;
    body = `${body.slice(0, split)}${(tail >>> 16).toString(16)}:${(tail & 0xffff).toString(16)}`;
  }
  const [head = '', rest, ...extra] = body.split('::');
  if (extra.length > 0) return null;
  const left = head === '' ? [] : head.split(':');
  const right = rest === undefined || rest === '' ? [] : rest.split(':');
  const groups = rest === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  if (groups.length !== 8) return null;
  return groups.reduce((n, group) => (n << 16n) | BigInt(parseInt(group, 16)), 0n);
}

const blockedV4 = ipv4Ranges.map((range) => asBlock(range, 32));
const embeddingV6 = ipv6EmbeddingRanges.map((range) => asBlock(range, 128));
const blockedV6 = ipv6Ranges.map((range) => asBlock(range, 128));
const unicastV6 = asBlock({ name: 'global-unicast', cidr: globalUnicast, rfc: 'RFC 4291' }, 128);

const publicIPv4 = (value: number) => !blockedV4.some((block) => contains(block, BigInt(value)));

function publicIPv6(value: bigint): boolean {
  if (embeddingV6.some((block) => contains(block, value))) return publicIPv4(Number(value & 0xffffffffn));
  return contains(unicastV6, value) && !blockedV6.some((block) => contains(block, value));
}

/**
 * Whether `address` (an IPv4 or IPv6 literal, as DNS or a URL gives it) is a public unicast
 * destination. Anything that is not an address is not public. An IPv4-mapped or NAT64 address is
 * judged by the IPv4 address inside it; every other special-purpose range is refused whole.
 */
export function isPublicAddress(address: string): boolean {
  const v4 = parseIPv4(address);
  if (v4 !== null) return publicIPv4(v4);
  const v6 = parseIPv6(address);
  return v6 !== null && publicIPv6(v6);
}
