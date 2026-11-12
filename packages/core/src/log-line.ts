import { format } from 'node:util';
import { errorLine } from './error-line.ts';

/**
 * One log entry from a console call's arguments, safe to write while serving a visitor: an error
 * (or an object holding one under `error`, `err`, `cause` or `reason`) becomes its errorLine, any
 * other object only its type name in brackets (`[Request]`, `[Object]`, `[Array]`: its fields can
 * hold anything), strings and the whole entry lose line breaks, other control characters and
 * terminal colours, and the entry is at most 2,000 characters. `%s`-style formats still work.
 * The web server routes every console method through this (web server/log-boundary.ts); Better
 * Auth's logger uses it too (identity/auth.ts).
 */
export function logLine(args: readonly unknown[]): string {
  const entry = oneLine(format(...args.map(logArgument)));
  return entry.length > maxEntry ? `${entry.slice(0, maxEntry - 1)}…` : entry;
}

const maxEntry = 2_000;

/** Text with no line break, control character or terminal colour code in it. */
export function oneLine(text: string): string {
  // oxlint-disable-next-line no-control-regex -- removing control characters is the point
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/[\u0000-\u0008\u000a-\u001f\u007f\u2028\u2029]+/g, ' ');
}

function logArgument(value: unknown): unknown {
  if (value instanceof Error) return errorLine(value);
  if (typeof value === 'string') return oneLine(value);
  if (value === null || typeof value !== 'object')
    return typeof value === 'function' || typeof value === 'symbol' ? `[${typeof value}]` : value;
  for (const field of ['error', 'err', 'cause', 'reason']) {
    const inner: unknown = (value as Record<string, unknown>)[field];
    if (inner instanceof Error) return errorLine(inner);
  }
  if (Array.isArray(value)) return '[Array]';
  const name = (value as { constructor?: { name?: unknown } }).constructor?.name;
  return `[${typeof name === 'string' && /^[\w$]{1,40}$/.test(name) ? name : 'Object'}]`;
}
