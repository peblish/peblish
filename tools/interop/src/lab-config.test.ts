import { readFileSync } from 'node:fs';
import { isPublicAddress } from '@peblish/core/net/public-address';
import { describe, expect, it } from 'vitest';

// Guards on the lab's own configuration (lab/compose.yaml), read as text: no YAML parser, no Docker.
const compose = readFileSync(new URL('../../../lab/compose.yaml', import.meta.url), 'utf8');

/** The lines of one top-level block (`services.<name>` or `x-<anchor>`), up to the next one. */
function block(header: RegExp, indent: number): string[] {
  const lines = compose.split('\n');
  const start = lines.findIndex((line) => header.test(line));
  if (start < 0) throw new Error(`no block ${header}`);
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && line.length - line.trimStart().length <= indent) break;
    out.push(line);
  }
  return out;
}

/** Variable names set in a mapping's lines (two spaces deeper than its header), merging `<<: *anchor` blocks. */
function keysOf(lines: string[], anchors: Record<string, string[]>): string[] {
  const keys: string[] = [];
  for (const line of lines) {
    const merge = /^\s+<<: \*(\S+)/.exec(line);
    if (merge) keys.push(...(anchors[merge[1]!] ?? []));
    const key = /^\s+([A-Z][A-Z0-9_]+):/.exec(line);
    if (key) keys.push(key[1]!);
  }
  return keys;
}

/** The environment variables a service sets, including those it merges from the `x-peblish-env` anchor. */
function serviceEnvironment(service: string): Set<string> {
  const anchors = { 'peblish-env': keysOf(block(/^x-peblish-env:/, 0), {}) };
  const lines = block(new RegExp(`^  ${service}:`), 2);
  const at = lines.findIndex((line) => /^ {4}environment:/.test(line));
  if (at < 0) return new Set();
  const body: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() !== '' && line.length - line.trimStart().length <= 4) break;
    body.push(line);
  }
  return new Set(keysOf(body, anchors));
}

describe('the lab runs the unmodified production image', () => {
  // The brief's exact list (PEBLISH_PROCESS per service). Anything else is a lab switch in the
  // image's behaviour, which would make a green lab say nothing about the deployed build.
  const allowed = [
    'BETTER_AUTH_SECRET',
    'DATABASE_URL',
    'NODE_EXTRA_CA_CERTS',
    'PEBLISH_PROCESS',
    'PEBLISH_TRUSTED_PROXY',
    'PUBLIC_ORIGIN',
  ];

  it.each(['peblish-migrate', 'peblish-web', 'peblish-worker'])('%s sets only the documented variables', (service) => {
    const keys = serviceEnvironment(service);
    for (const key of keys) expect(allowed).toContain(key);
    for (const key of ['PEBLISH_PROCESS', 'DATABASE_URL', 'PUBLIC_ORIGIN', 'BETTER_AUTH_SECRET', 'NODE_EXTRA_CA_CERTS'])
      expect(keys).toContain(key);
  });

  it('builds the root Dockerfile, with no target or build argument', () => {
    const lines = block(/^  peblish-migrate:/, 2).join('\n');
    expect(lines).toMatch(/context: \.\.\n/);
    expect(lines).not.toMatch(/dockerfile:|target:|args:/);
    expect(lines).toContain('image: peblish:lab');
  });

  it('mounts no source over the image', () => {
    for (const service of ['peblish-migrate', 'peblish-web', 'peblish-worker']) {
      const lines = block(new RegExp(`^  ${service}:`), 2).join('\n');
      expect(lines).not.toMatch(/\.\.\//);
    }
  });

  it('keeps the lab network internal, on the public /24', () => {
    expect(block(/^  lab:/, 2).join('\n')).toContain('internal: true');
    expect(compose).toContain('subnet: 44.255.99.0/24');
  });
});

describe('the lab subnet', () => {
  it('has every address accepted by isPublicAddress, so safeFetch needs no overlay', () => {
    const refused = Array.from({ length: 256 }, (_, last) => `44.255.99.${last}`).filter((address) => !isPublicAddress(address));
    expect(refused).toEqual([]);
  });

  it('is not the retired 6to4 prefix the spike used, which isPublicAddress refuses', () => {
    expect(isPublicAddress('192.88.99.5')).toBe(false);
  });
});
