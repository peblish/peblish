import { expect, test } from 'vitest';
import { Refused } from '../tx/refused.ts';
import { assertMove, canMove, scanStates, type ScanState } from './state.ts';

const allowed: [ScanState, ScanState][] = [
  ['pending', 'clean'],
  ['pending', 'quarantined'],
  ['pending', 'failed'],
  ['quarantined', 'blocked'],
  ['quarantined', 'clean'],
  ['clean', 'quarantined'],
];

test('exactly the six moves of the state machine are allowed, and every other pair is refused', () => {
  for (const from of scanStates)
    for (const to of scanStates) {
      const expected = allowed.some(([a, b]) => a === from && b === to);
      expect(canMove(from, to), `${from} to ${to}`).toBe(expected);
    }
});

test('a refused move throws the reason its caller names, and an allowed one throws nothing', () => {
  expect(() => assertMove('media.scan', 'clean', 'clean', 'media.not_pending')).toThrow(new Refused('media.scan', 'media.not_pending'));
  expect(() => assertMove('media.review', 'clean', 'blocked', 'media.not_quarantined')).toThrow(
    new Refused('media.review', 'media.not_quarantined'),
  );
  expect(() => assertMove('media.scan', 'pending', 'clean', 'media.not_pending')).not.toThrow();
});
