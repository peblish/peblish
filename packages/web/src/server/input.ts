import { issueSummary } from '@peblish/core/error-line';
import { type, type Type } from 'arktype';

/**
 * A server function's input that its schema refused. Its message names each parameter and the
 * kind of problem (ArkType's code), never a value, so it is safe in the log and in the reply the
 * browser gets. Route failures log `problems` (shell/route-failure.ts).
 */
export class InputError extends Error {
  override name = 'InputError';
  readonly problems: string;
  constructor(problems: string) {
    super(`input refused (${problems})`);
    this.problems = problems;
  }
}

/**
 * A server function's validator: `.validator(input(type({ ... })))`. TanStack Start turns a
 * failing Standard Schema into `new Error(JSON.stringify(issues))`, values and all; a function
 * validator's own error passes through, so the refusal keeps its structure here instead.
 */
export function input<T extends Type>(schema: T): (data: T['inferIn']) => T['infer'] {
  return (data) => {
    const out: unknown = schema(data);
    if (out instanceof type.errors) throw new InputError(issueSummary(out));
    return out as T['infer'];
  };
}
