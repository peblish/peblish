import { beforeEach, describe, expect, test } from 'vitest';
import {
  heldWindows,
  perHostBudget,
  perSignerRate,
  pipelinePerHostBudget,
  resetKeyFetchBudget,
  takeIntake,
  takeKeyFetch,
  takePipelineFetch,
} from './throttle.ts';

beforeEach(resetKeyFetchBudget);

const uses = (take: () => boolean, count: number) => Array.from({ length: count }, take);

describe('the inbox budgets', () => {
  test('a host spends its own allowance, a window lasts a minute, and a spent window stays spent', () => {
    const now = 1_000_000;
    expect(uses(() => takeKeyFetch('a.test', now), perHostBudget).every(Boolean)).toBe(true);
    expect(takeKeyFetch('a.test', now)).toBe(false);
    expect(takeKeyFetch('b.test', now)).toBe(true);
    expect(takeKeyFetch('a.test', now + 59_000)).toBe(false);
    expect(takeKeyFetch('a.test', now + 60_000)).toBe(true);
  });

  test('the three budgets are separate: spending one leaves the others whole', () => {
    uses(() => takeKeyFetch('a.test'), perHostBudget + 1);
    expect(takeKeyFetch('a.test')).toBe(false);
    expect(uses(() => takePipelineFetch('a.test'), pipelinePerHostBudget).every(Boolean)).toBe(true);
    expect(takeIntake('https://a.test/u/x')).toBe(true);
    uses(() => takeIntake('https://a.test/u/x'), perSignerRate);
    expect(takeIntake('https://a.test/u/x')).toBe(false);
    expect(takeIntake('https://a.test/u/y')).toBe(true);
  });

  test('the tables stay bounded however many hosts and signers a flood names', () => {
    for (let n = 0; n < 7000; n++) {
      takeKeyFetch(`h${n}.test`);
      takeIntake(`https://h${n}.test/u/x`);
    }
    // Three tables, each capped at 2000 windows.
    expect(heldWindows()).toBeLessThanOrEqual(6000);
  });
});
