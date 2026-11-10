import { readFileSync } from 'node:fs';
import { type, type Type } from 'arktype';

// What the cutover tool may print of a failure. Its files (the bundle, PieFed's key files, ledger
// exports) hold private keys and email addresses, and most errors quote what they choke on:
// JSON.parse an excerpt of the text, ArkType the offending value, a Drizzle query error its
// parameters, a Postgres error the conflicting value, pg_restore the row it could not load. So
// the CLI prints a message only from the tool's own CutoverError, which never carries file
// content, and for anything else a fixed description from codes, constraint names and paths.

/** A failure the tool describes itself; its message is safe to print. */
export class CutoverError extends Error {
  override name = 'CutoverError';
}

/** Where a JSON syntax error is, as numbers only (V8 says "at position N (line L column C)"). */
function position(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const line = /\(line (\d+) column (\d+)\)/.exec(message);
  if (line) return ` at line ${line[1]}, column ${line[2]}`;
  const at = /at position (\d+)/.exec(message)?.[1];
  return at ? ` at position ${at}` : '';
}

/**
 * The paths that failed and what each must be, without the values found there. ArkType's
 * `expected` and `message` can quote the value (a union's do, "must be ... (was ...)"), so only
 * the schema's own `description` is used, and a path without one gets a fixed phrase.
 */
export const formatProblems = (errors: type.errors): string =>
  errors
    .map((e) => {
      const description: unknown = 'description' in e ? e.description : undefined;
      const what =
        typeof description === 'string' && !description.includes('(was ') ? `must be ${description}` : 'has the wrong type or value';
      return `${e.propString || '(root)'} ${what}`;
    })
    .join('; ');

/**
 * Reads `file` as JSON and checks it against `schema`. Bad JSON or a mismatch is a CutoverError
 * naming `what` and a position or the failing paths, and nothing of the content.
 */
export function readJsonFile<T>(file: string, what: string, schema: Type<T>): T {
  const text = readFileSync(file, 'utf8');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new CutoverError(`${what} is not valid JSON${position(error)}`);
  }
  const checked = schema(value);
  if (checked instanceof type.errors) throw new CutoverError(`${what} does not match its format: ${formatProblems(checked)}`);
  return checked as T;
}

const field = (error: Error, name: string): string | undefined => {
  const value = (error as Error & Record<string, unknown>)[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
};

/** What the CLI prints for a failure: a CutoverError's message, otherwise codes and names only. */
export function describe(error: unknown): string {
  if (error instanceof CutoverError) return error.message;
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    if ('severity' in cause && 'code' in cause) {
      const where = ['constraint_name', 'table_name', 'column_name']
        .map((name) => field(cause, name))
        .filter((value) => value !== undefined);
      return `database error ${String(cause.code)}${where.length > 0 ? ` (${where.join(', ')})` : ''}; its message is withheld (it can quote values)`;
    }
  }
  if (!(error instanceof Error)) return 'unknown failure';
  if (error.name === 'DrizzleQueryError') return 'a database query failed (its parameters are withheld)';
  if ('arkErrors' in error && error.arkErrors instanceof type.errors)
    return `the input does not match its format: ${formatProblems(error.arkErrors)}`;
  // A Node system error (a file that exists, a missing file, a refused connection): its code, call and path.
  const code = field(error, 'code');
  if (code && field(error, 'syscall')) return [code, field(error, 'syscall'), field(error, 'path')].filter(Boolean).join(' ');
  return `${error.name}; its message is withheld (it can quote values)`;
}
