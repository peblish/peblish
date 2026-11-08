// The delivery guard (src/safe-post.ts) lets public addresses through and
// refuses the rest. Run with `npm test`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

// safe-post.ts reads FEDDIT_LAB_CIDR when it is imported, so the default case
// must load it without that variable.
delete process.env.FEDDIT_LAB_CIDR;
const { isAllowedAddress } = await import("../src/safe-post.ts");

const ALLOWED = [
  // Real addresses of feddit.com, lemmy.world, fedia.io and piefed.social: the ones a live run was refused.
  "172.64.80.1",
  "104.26.8.209",
  "144.76.91.164",
  "103.16.129.132",
  "8.8.8.8",
  "2606:4700::1",
  "2a01:4f8::1",
  "2001:4860:4860::8888",
  // IPv4-mapped IPv6 is judged as the IPv4 address inside it.
  "::ffff:172.64.80.1",
  "::ffff:ac40:5001",
];

const BLOCKED = [
  "10.0.0.1", // RFC 1918
  "172.16.0.1",
  "192.168.1.1",
  "127.0.0.1", // loopback
  "169.254.1.1", // link-local
  "100.64.0.1", // CGNAT
  "192.0.2.1", // documentation
  "198.51.100.7",
  "203.0.113.9",
  "0.0.0.0", // "this network"
  "224.0.0.1", // multicast
  "240.0.0.1", // reserved
  "255.255.255.255",
  "192.88.99.5", // the lab subnet, unless FEDDIT_LAB_CIDR names it
  "::1",
  "::",
  "fe80::1", // link-local
  "fe80::1%eth0",
  "fc00::1", // ULA
  "fd12:3456::1",
  "ff02::1", // multicast
  "2001:db8::1", // documentation
  "64:ff9b::a00:1", // NAT64
  "64:ff9b:1::a00:1", // local-use NAT64
  "2002:7f00:1::1", // 6to4 around 127.0.0.1
  "2002:808:808::1", // 6to4 around 8.8.8.8
  "fec0::1", // deprecated site-local
  "::127.0.0.1", // IPv4-compatible
  "::8.8.8.8",
  "::a00:1",
  "::ffff:10.0.0.1", // IPv4-mapped private, in both spellings
  "::ffff:a00:1",
  "::ffff:127.0.0.1",
  "0:0:0:0:0:ffff:192.168.0.1",
  "not an address",
  "",
];

test("public addresses are allowed", () => {
  for (const address of ALLOWED) assert.equal(isAllowedAddress(address), true, address);
});

test("special-purpose addresses are blocked", () => {
  for (const address of BLOCKED) assert.equal(isAllowedAddress(address), false, address);
});

// Child process, because the allowlist is read once at import.
test("FEDDIT_LAB_CIDR allows its own range and nothing else private", () => {
  const script = `
    import { isAllowedAddress } from ${JSON.stringify(new URL("../src/safe-post.ts", import.meta.url).href)};
    const addresses = ["192.88.99.5", "::ffff:192.88.99.5", "192.0.2.1", "10.0.0.1", "127.0.0.1", "172.64.80.1"];
    console.log(JSON.stringify(addresses.map((address) => isAllowedAddress(address))));
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
    env: { ...process.env, FEDDIT_LAB_CIDR: "192.88.99.0/24" },
    encoding: "utf8",
  });
  assert.deepEqual(JSON.parse(output), [true, true, false, false, false, true]);
});
