import { beforeEach, describe, expect, test } from 'vitest';
import {
  heldWindows,
  lookupBudgets,
  perSignerRate,
  pipelinePerHostBudget,
  resetKeyFetchBudget,
  takeIntake,
  takeKeyLookup,
  takePipelineFetch,
} from './throttle.ts';

beforeEach(resetKeyFetchBudget);

const uses = (take: () => boolean, count: number) => Array.from({ length: count }, take);
const { discovery, refresh } = lookupBudgets;

describe('the inbox budgets', () => {
  test('a host spends its own allowance, a window lasts a minute, and a spent window stays spent', () => {
    const now = 1_000_000;
    const from = (n: number) => `192.0.2.${n}`;
    // Enough distinct clients that no address is the limit.
    expect(uses(() => takeKeyLookup('discovery', { address: from(1), host: 'a.test' }, now), discovery.perAddress).every(Boolean)).toBe(
      true,
    );
    expect(uses(() => takeKeyLookup('discovery', { address: from(2), host: 'a.test' }, now), discovery.perAddress).every(Boolean)).toBe(
      true,
    );
    expect(takeKeyLookup('discovery', { address: from(3), host: 'a.test' }, now)).toBe(false);
    expect(takeKeyLookup('discovery', { address: from(3), host: 'b.test' }, now)).toBe(true);
    expect(takeKeyLookup('discovery', { address: from(4), host: 'a.test' }, now + 59_000)).toBe(false);
    expect(takeKeyLookup('discovery', { address: from(5), host: 'a.test' }, now + 60_000)).toBe(true);
  });

  test('an address over its allowance is refused alone: the host and the total are not spent by it', () => {
    const now = 1_000_000;
    const flood = (address: string) => takeKeyLookup('discovery', { address, host: 'peer.test' }, now);
    expect(uses(() => flood('192.0.2.1'), discovery.perAddress).every(Boolean)).toBe(true);
    // Twice as many again from the same address: all refused, none charged to the host.
    expect(uses(() => flood('192.0.2.1'), 2 * discovery.perAddress).some(Boolean)).toBe(false);
    // The host still has what is left of its own allowance for others.
    expect(uses(() => flood('192.0.2.2'), discovery.perHost - discovery.perAddress).every(Boolean)).toBe(true);
    expect(flood('192.0.2.2')).toBe(false);
    // One address is one address: IPv6 clients of one /64 share a window.
    expect(takeKeyLookup('discovery', { address: '2001:db8::1', host: 'other.test' }, now)).toBe(true);
    expect(
      uses(() => takeKeyLookup('discovery', { address: '2001:db8::ffff', host: 'other.test' }, now), discovery.perAddress).slice(-1),
    ).toEqual([false]);
  });

  test('refreshing an actor we hold has its own allowance, apart from discovering a stranger', () => {
    const now = 1_000_000;
    for (let n = 0; n < 12; n++)
      uses(() => takeKeyLookup('discovery', { address: `192.0.2.${n}`, host: 'peer.test' }, now), discovery.perAddress);
    expect(takeKeyLookup('discovery', { address: '192.0.2.100', host: 'peer.test' }, now)).toBe(false);
    expect(
      uses(() => takeKeyLookup('refresh', { address: '192.0.2.100', host: 'peer.test' }, now), refresh.perAddress).every(Boolean),
    ).toBe(true);
    expect(takeKeyLookup('refresh', { address: '192.0.2.100', host: 'peer.test' }, now)).toBe(false);
    expect(takeKeyLookup('refresh', { address: '192.0.2.101', host: 'peer.test' }, now)).toBe(true);
  });

  test('a request whose address cannot be told shares one window, so it is limited, not unlimited', () => {
    expect(uses(() => takeKeyLookup('discovery', { address: null, host: 'a.test' }), discovery.perAddress).every(Boolean)).toBe(true);
    expect(takeKeyLookup('discovery', { address: null, host: 'b.test' })).toBe(false);
    expect(takeKeyLookup('discovery', { address: '192.0.2.1', host: 'b.test' })).toBe(true);
  });

  test('the budgets are separate: spending one leaves the others whole', () => {
    uses(() => takeKeyLookup('discovery', { address: '192.0.2.1', host: 'a.test' }), discovery.perAddress + 1);
    expect(takeKeyLookup('discovery', { address: '192.0.2.1', host: 'a.test' })).toBe(false);
    expect(uses(() => takePipelineFetch('a.test'), pipelinePerHostBudget).every(Boolean)).toBe(true);
    expect(takeIntake('https://a.test/u/x')).toBe(true);
    uses(() => takeIntake('https://a.test/u/x'), perSignerRate);
    expect(takeIntake('https://a.test/u/x')).toBe(false);
    expect(takeIntake('https://a.test/u/y')).toBe(true);
  });

  test('the tables stay bounded however many hosts, addresses and signers a flood names', () => {
    for (let n = 0; n < 7000; n++) {
      takeKeyLookup('discovery', { address: `10.${n >> 8}.${n & 255}.1`, host: `h${n}.test` });
      takeKeyLookup('refresh', { address: `10.${n >> 8}.${n & 255}.2`, host: `h${n}.test` });
      takeIntake(`https://h${n}.test/u/x`);
    }
    // Four tables, each capped at 2000 windows.
    expect(heldWindows()).toBeLessThanOrEqual(8000);
  });
});
