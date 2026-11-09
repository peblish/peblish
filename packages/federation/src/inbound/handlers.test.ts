import { expect, test } from 'vitest';
import { inboundHandlers } from '../registry/inbound-handlers.gen.ts';

test('inbound handlers register by glob with one handler per activity type', () => {
  const types = inboundHandlers.map(({ type }) => type);
  expect(new Set(types).size).toBe(types.length);
});
