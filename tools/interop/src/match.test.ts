import { describe, expect, it } from 'vitest';
import { type DeliveryRow, type InboxRow, matchDelivery, matchInbound, Mismatch } from './match.ts';
import { recorder } from './lab.ts';

const query = { since: new Date(0), type: 'Announce', contains: 'https://lemmy.lab.test/post/1' };
const row = (state: string, error: string | null = null): InboxRow => ({
  id: '1',
  activityId: 'a',
  type: 'Announce',
  actor: 'x',
  state,
  error,
});

describe('matchInbound', () => {
  it('passes when the recorded reason is the expected one', () => {
    expect(matchInbound([row('skipped', 'announce.person')], query, { state: 'skipped', reason: 'announce.person' }).state).toBe('skipped');
    expect(matchInbound([row('applied')], query, { state: 'applied' }).state).toBe('applied');
  });

  it('compares the detail exactly: reason, one space, detail', () => {
    const bare = row('skipped', 'announce.bare_iri https://mbin.lab.test/m/lab/t/1');
    expect(() =>
      matchInbound([bare], query, { state: 'skipped', reason: 'announce.bare_iri', detail: 'https://mbin.lab.test/m/lab/t/1' }),
    ).not.toThrow();
    expect(() => matchInbound([bare], query, { state: 'skipped', reason: 'announce.bare_iri' })).toThrow(Mismatch);
  });

  it('fails on another reason, and names both', () => {
    expect(() => matchInbound([row('skipped', 'announce.person')], query, { state: 'skipped', reason: 'announce.bare_iri' })).toThrow(
      'expected [skipped announce.bare_iri], got [skipped announce.person]',
    );
  });

  it('fails on a state change with no reason: applied is not skipped', () => {
    expect(() => matchInbound([row('applied')], query, { state: 'skipped', reason: 'duplicate' })).toThrow('got [applied]');
  });

  it('fails when no row matches, and when two do', () => {
    expect(() => matchInbound([], query, { state: 'applied' })).toThrow('no inbox row for Announce about https://lemmy.lab.test/post/1');
    expect(() => matchInbound([row('applied'), row('applied')], query, { state: 'applied' })).toThrow('2 inbox rows');
  });

  it('gives a known defect an exact signature in the message, and the recorder files it as known', async () => {
    const rec = recorder();
    const signature = 'got [skipped announce.person]';
    const defect = { explanation: 'a boost is ignored', signature };
    const body = async () => void matchInbound([row('skipped', 'announce.person')], query, { state: 'applied' });
    const quiet = console.log;
    console.log = () => undefined;
    try {
      await rec.scenario('K1', 'peer', body, defect);
      await rec.scenario('K2', 'peer', body, { explanation: 'x', signature: 'got [skipped announce.bare_iri]' });
      await rec.scenario('K3', 'peer', async () => undefined, defect);
    } finally {
      console.log = quiet;
    }
    expect(rec.results.map((r) => r.status)).toEqual(['known', 'fail', 'pass']);
    expect(rec.results[2]?.note).toContain('defect fixed, remove the known entry');
  });
});

const delivery = (over: Partial<DeliveryRow> = {}): DeliveryRow => ({
  activityApId: 'https://peblish.lab.test/a/1',
  type: 'Create',
  inbox: 'https://lemmy.lab.test/inbox',
  state: 'failed',
  attempts: 1,
  status: 400,
  error: null,
  nextAttemptAt: new Date(0),
  ...over,
});

describe('matchDelivery', () => {
  it('compares state, status and attempts exactly', () => {
    const q = { since: new Date(0), type: 'Create' };
    expect(() => matchDelivery([delivery()], q, { state: 'failed', status: 400, attempts: 1 })).not.toThrow();
    expect(() => matchDelivery([delivery()], q, { state: 'failed', status: 403 })).toThrow('got [failed status=400');
    expect(() => matchDelivery([delivery({ state: 'pending' })], q, { state: 'delivered' })).toThrow(Mismatch);
    expect(() => matchDelivery([], q, { state: 'delivered' })).toThrow('no delivery');
    expect(() => matchDelivery([delivery(), delivery()], q, { state: 'failed' })).toThrow('2 deliveries');
  });
});
