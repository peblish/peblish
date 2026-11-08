import { describe, expect, test } from 'vitest';
import { frozenCopy, SnapshotError } from './frozen.ts';

class Point {
  x = 1;
}
const cyclic: { self?: unknown } = {};
cyclic.self = cyclic;
const symbolKeyed = { [Symbol('key')]: 1 };
const accessor = {
  get value() {
    return 1;
  },
};

describe('frozenCopy', () => {
  test.each([
    ['a Date', { at: new Date() }, 'value.at', 'Date'],
    ['a Buffer', { body: Buffer.from('abc') }, 'value.body', 'Buffer'],
    ['a typed array', [new Uint8Array([1])], 'value[0]', 'Uint8Array'],
    ['a Map', { m: new Map() }, 'value.m', 'Map'],
    ['a Set', { s: new Set() }, 'value.s', 'Set'],
    ['a class instance', { p: new Point() }, 'value.p', 'Point'],
    ['a function', { f: () => 1 }, 'value.f', 'a function'],
    ['a symbol', { s: Symbol('s') }, 'value.s', 'a symbol'],
    ['a symbol-keyed property', { nested: symbolKeyed }, 'value.nested', 'a symbol-keyed property'],
    ['an accessor', { nested: accessor }, 'value.nested.value', 'an accessor property'],
    ['a cycle', cyclic, 'value.self', 'a cycle'],
  ])('rejects %s with SnapshotError', (_name, input, path, found) => {
    const error = (() => {
      try {
        frozenCopy(input);
      } catch (thrown) {
        return thrown;
      }
    })();
    expect(error).toBeInstanceOf(SnapshotError);
    expect(error).toMatchObject({ path, found });
  });

  test('copies and deep-freezes JSON-like data, shared references included', () => {
    const shared = { id: 'a' };
    const bare: Record<string, unknown> = Object.create(null);
    bare.flag = true;
    const input = { n: 1, s: 'x', b: false, nil: null, none: undefined, big: 2n, list: [shared, shared], bare };
    const copy = frozenCopy(input);
    expect(copy).toEqual(input);
    expect(copy).not.toBe(input);
    expect(Object.isFrozen(copy.list[0])).toBe(true);
    expect(Object.isFrozen(copy.bare)).toBe(true);
    shared.id = 'changed';
    expect(copy.list[0]?.id).toBe('a');
  });
});
