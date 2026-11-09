import { describe, expect, test } from 'vitest';
import { decodeCursor, encodeCursor, type Cursor } from './cursor.ts';

// The cursor is unsigned text from the address bar: whatever it says, decoding either gives
// back something the queries can take as a parameter or nothing at all.

const now = Date.parse('2026-11-09T12:00:00.000Z');
const id = '3f2b8c1e-6a4d-4f7e-9b1a-0c5d2e8f7a61';
const position = { v: 1, id, period: 'all', asOf: now, pub: (now - 3_600_000) * 1000 } as const;
const valid = {
  new: { ...position, sort: 'new' },
  old: { ...position, sort: 'old' },
  top: { ...position, sort: 'top', score: -3 },
  'hot, ranked': { ...position, sort: 'hot', rank: 0.37 },
  'hot, past the week': { ...position, sort: 'hot', rank: null },
} satisfies Record<string, Cursor>;
/** The cursor as text, from raw JSON so that a value JSON.stringify would refuse (1e999) can be written. */
const text = (json: string) => Buffer.from(json).toString('base64url');
const decode = (cursor: object) => decodeCursor(text(JSON.stringify(cursor)), now);

describe('decodeCursor', () => {
  test.each(Object.entries(valid))('%s: a cursor the server handed out comes back as it was', (_label, cursor) => {
    expect(decodeCursor(encodeCursor(cursor), now)).toEqual(cursor);
  });

  test('a clock a little ahead of this one is skew, a day ahead is forged', () => {
    expect(decode({ ...valid.new, asOf: now + 30_000 })).not.toBeNull();
    expect(decode({ ...valid.new, asOf: now + 86_400_000, pub: 1 })).toBeNull();
  });

  const forged: [string, Partial<Record<keyof Cursor, unknown>>][] = [
    ['asOf past what Postgres reads as a bigint', { asOf: 1e300 }],
    ['asOf that is not a safe integer', { asOf: 2 ** 53 }],
    ['asOf with a fraction', { asOf: now + 0.5 }],
    ['asOf of zero or less', { asOf: 0 }],
    ['pub past what Postgres reads as a bigint', { pub: 1e300 }],
    ['pub that is not a safe integer', { pub: 2 ** 53 }],
    ['pub with a fraction', { pub: position.pub + 0.5 }],
    ['pub of zero or less', { pub: -1 }],
    ['pub after the page clock', { pub: (now + 1000) * 1000 }],
    ['an id that is not a uuid', { id: "1'; drop table posts; --" }],
    ['a version that is not 1', { v: 2 }],
    ['text for a number', { asOf: String(now) }],
  ];
  test.each(forged)('%s is no cursor', (_label, change) => {
    for (const cursor of Object.values(valid)) expect(decode({ ...cursor, ...change }), JSON.stringify(cursor)).toBeNull();
  });

  const sortSpecific: [string, Cursor['sort'], Partial<Record<keyof Cursor, unknown>>][] = [
    ['a score past int4', 'top', { score: 2 ** 31 }],
    ['a score below int4', 'top', { score: -(2 ** 31) - 1 }],
    ['a score of 1e300', 'top', { score: 1e300 }],
    ['a score with a fraction', 'top', { score: 1.5 }],
    ['a Top cursor without its score', 'top', { score: undefined }],
    ['a rank below zero', 'hot', { rank: -0.5 }],
    ['a rank past any real one', 'hot', { rank: 11 }],
    ['a Hot cursor without its rank', 'hot', { rank: undefined }],
  ];
  test.each(sortSpecific)('%s is no cursor', (_label, sort, change) => {
    const base = sort === 'top' ? valid.top : valid['hot, ranked'];
    expect(decode({ ...base, ...change })).toBeNull();
  });

  test('a rank that is not finite is no cursor (JSON text can say 1e999)', () => {
    const json = JSON.stringify(valid['hot, ranked']).replace(/"rank":[^,}]+/, '"rank":1e999');
    expect(json).toContain('1e999');
    expect(decodeCursor(text(json), now)).toBeNull();
  });

  test.each(['', undefined, 'not-a-cursor', text('{"v":1}'), text('null'), text('[]'), text('{"v":1,'), 'x'.repeat(401)])(
    'garbage (%s) is no cursor',
    (garbage) => {
      expect(decodeCursor(garbage, now)).toBeNull();
    },
  );
});
