import { type } from 'arktype';
import { expect, test } from 'vitest';
import { InputError, input } from './input.ts';

const marker = 'MARKER-typed@example.test';

test('a server function input that passes comes back as the schema outputs it', () => {
  const validate = input(type({ handle: 'string <= 300', 'n?': 'string.integer.parse' }));
  expect(validate({ handle: 'ada', n: '4' })).toEqual({ handle: 'ada', n: 4 });
});

test("a refused input throws an InputError naming each parameter and its problem, never the visitor's value", () => {
  const validate = input(type({ handle: 'string <= 300', 'cursor?': 'string.uuid' }));
  let thrown: unknown;
  try {
    validate({ handle: `${'a'.repeat(310)}${marker}`, cursor: marker });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(InputError);
  const refused = thrown as InputError;
  expect(refused.problems).toBe('handle: maxLength, cursor: pattern');
  expect(`${refused.message} ${refused.stack}`).not.toContain(marker);
});
