import { expect, test } from 'vitest';
import { ipv4Ranges, ipv6EmbeddingRanges, ipv6Ranges, isPublicAddress } from './public-address.ts';

// One row per named range: its first and last address are refused, and the address just
// outside each end is public (omitted where the neighbour is another blocked range).
type Row = { range: string; inside: [string, string]; before?: string; after?: string };

const ipv4: Row[] = [
  { range: 'this-network', inside: ['0.0.0.0', '0.255.255.255'], after: '1.0.0.0' },
  { range: 'private-10', inside: ['10.0.0.0', '10.255.255.255'], before: '9.255.255.255', after: '11.0.0.0' },
  { range: 'cgnat', inside: ['100.64.0.0', '100.127.255.255'], before: '100.63.255.255', after: '100.128.0.0' },
  { range: 'loopback', inside: ['127.0.0.0', '127.255.255.255'], before: '126.255.255.255', after: '128.0.0.0' },
  { range: 'link-local', inside: ['169.254.0.0', '169.254.255.255'], before: '169.253.255.255', after: '169.255.0.0' },
  { range: 'private-172', inside: ['172.16.0.0', '172.31.255.255'], before: '172.15.255.255', after: '172.32.0.0' },
  { range: 'ietf-protocol-assignments', inside: ['192.0.0.0', '192.0.0.255'], before: '191.255.255.255', after: '192.0.1.0' },
  { range: 'documentation-1', inside: ['192.0.2.0', '192.0.2.255'], before: '192.0.1.255', after: '192.0.3.0' },
  { range: '6to4-relay-anycast', inside: ['192.88.99.0', '192.88.99.255'], before: '192.88.98.255', after: '192.88.100.0' },
  { range: 'private-192', inside: ['192.168.0.0', '192.168.255.255'], before: '192.167.255.255', after: '192.169.0.0' },
  { range: 'benchmarking', inside: ['198.18.0.0', '198.19.255.255'], before: '198.17.255.255', after: '198.20.0.0' },
  { range: 'documentation-2', inside: ['198.51.100.0', '198.51.100.255'], before: '198.51.99.255', after: '198.51.101.0' },
  { range: 'documentation-3', inside: ['203.0.113.0', '203.0.113.255'], before: '203.0.112.255', after: '203.0.114.0' },
  { range: 'multicast', inside: ['224.0.0.0', '239.255.255.255'], before: '223.255.255.255' },
  // The last address is the limited broadcast.
  { range: 'reserved', inside: ['240.0.0.0', '255.255.255.255'] },
];

const ipv6: Row[] = [
  { range: 'unspecified', inside: ['::', '::'] },
  { range: 'loopback', inside: ['::1', '::1'] },
  // Whole, not judged by the IPv4 inside: ::8.8.8.8 is refused too (see the next tests).
  { range: 'ipv4-compatible', inside: ['::2', '::ffff:ffff'] },
  { range: 'nat64-local-use', inside: ['64:ff9b:1::', '64:ff9b:1:ffff:ffff:ffff:ffff:ffff'] },
  { range: 'discard', inside: ['100::', '100::ffff:ffff:ffff:ffff'] },
  {
    range: 'ietf-protocol-assignments',
    inside: ['2001::', '2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff'],
    before: '2000:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    after: '2001:200::',
  },
  { range: 'teredo', inside: ['2001::', '2001:0:ffff:ffff:ffff:ffff:ffff:ffff'] },
  {
    range: 'documentation',
    inside: ['2001:db8::', '2001:db8:ffff:ffff:ffff:ffff:ffff:ffff'],
    before: '2001:db7:ffff:ffff:ffff:ffff:ffff:ffff',
    after: '2001:db9::',
  },
  {
    range: '6to4',
    inside: ['2002::', '2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
    before: '2001:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    after: '2003::',
  },
  {
    range: 'documentation-3fff',
    inside: ['3fff::', '3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff'],
    before: '3ffe:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    after: '3fff:1000::',
  },
  { range: 'unique-local', inside: ['fc00::', 'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'] },
  { range: 'link-local', inside: ['fe80::', 'febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff'] },
  { range: 'site-local', inside: ['fec0::', 'feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'] },
  { range: 'multicast', inside: ['ff00::', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'] },
];

function expectRows(rows: Row[]) {
  for (const { range, inside, before, after } of rows) {
    for (const address of inside) expect(isPublicAddress(address), `${range}: ${address} is inside`).toBe(false);
    for (const address of [before, after]) if (address) expect(isPublicAddress(address), `${range}: ${address} is outside`).toBe(true);
  }
}

test('every blocked IPv4 range refuses its edges and lets its neighbours through', () => {
  expectRows(ipv4);
});

test('every blocked IPv6 range refuses its edges and lets its neighbours through', () => {
  expectRows(ipv6);
});

test('the tables above cover every range the predicate names', () => {
  expect(ipv4.map((row) => row.range)).toEqual(ipv4Ranges.map((range) => range.name));
  expect(ipv6.map((row) => row.range)).toEqual(ipv6Ranges.map((range) => range.name));
});

test('an IPv4-mapped or NAT64 address is judged by the IPv4 address inside it, in every spelling', () => {
  expect(ipv6EmbeddingRanges.map((range) => range.name)).toEqual(['ipv4-mapped', 'nat64']);
  const public4 = [
    '::ffff:172.64.80.1',
    '::ffff:ac40:5001',
    '0:0:0:0:0:ffff:172.64.80.1',
    '::FFFF:8.8.8.8',
    '64:ff9b::8.8.8.8',
    '64:ff9b::808:808',
  ];
  const private4 = [
    '::ffff:10.0.0.1',
    '::ffff:a00:1',
    '0:0:0:0:0:ffff:192.168.0.1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:100.64.0.1',
    '::ffff:0.0.0.0',
    '::ffff:255.255.255.255',
    '64:ff9b::10.0.0.1',
    '64:ff9b::a00:1',
    '64:ff9b::7f00:1',
  ];
  // The deprecated IPv4-compatible form is never a destination, even around a public IPv4 address.
  private4.push('::8.8.8.8', '::808:808', '2002:808:808::1');
  for (const address of public4) expect(isPublicAddress(address), address).toBe(true);
  for (const address of private4) expect(isPublicAddress(address), address).toBe(false);
});

test('real public addresses pass, in both families', () => {
  // The addresses of feddit.com, lemmy.world, fedia.io and piefed.social that the spike's first guard refused.
  for (const address of ['172.64.80.1', '104.26.8.209', '144.76.91.164', '103.16.129.132', '8.8.8.8', '1.1.1.1', '223.255.255.255']) {
    expect(isPublicAddress(address), address).toBe(true);
  }
  for (const address of ['2606:4700::1', '2a01:4f8::1', '2001:4860:4860::8888', '2400:cb00::1', '3ffe::1']) {
    expect(isPublicAddress(address), address).toBe(true);
  }
});

test('IPv6 space outside global unicast is refused whatever it is called', () => {
  for (const address of ['4000::1', '8000::1', 'a000::1', 'e000::1', '0100:0:0:1::1', '::1:0:0', '1000::1']) {
    expect(isPublicAddress(address), address).toBe(false);
  }
});

test('text that is not an address is not public: names, odd IPv4 forms, zones, brackets', () => {
  for (const text of [
    '',
    'not an address',
    'localhost',
    'example.com',
    '127.1',
    '0x7f.0.0.1',
    '017700000001',
    '2130706433',
    '010.0.0.1',
    '1.2.3',
    '1.2.3.4.5',
    '256.1.1.1',
  ]) {
    expect(isPublicAddress(text), JSON.stringify(text)).toBe(false);
  }
  for (const text of ['fe80::1%eth0', '2606:4700::1%eth0', '[2606:4700::1]', ' 8.8.8.8', '8.8.8.8 ', '::g', '1::2::3']) {
    expect(isPublicAddress(text), JSON.stringify(text)).toBe(false);
  }
});
