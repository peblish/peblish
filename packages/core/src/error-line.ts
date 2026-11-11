/**
 * An error as one log line that cannot carry what a visitor or a peer sent. An error's message
 * often quotes its input: ArkType's "(was ...)", drizzle's `params:` list, Postgres's quoted value,
 * an SMTP refusal's recipient, a message the app built ("no such community: <name>"). So no
 * message is read, only fields whose shape cannot hold input: the class name, a short code
 * (a Postgres SQLSTATE, a Node or SMTP error code), the first frame in this repository's code as
 * `file:line`, and the same for up to three causes, by name and code.
 *
 * What a reader can tell from it: which kind of failure (class, code), where it was thrown, and
 * what it was caused by. What they cannot: the values involved; reproduce from the route and time.
 */
export function errorLine(error: unknown): string {
  if (!(error instanceof Error)) return `a thrown ${typeof error}`;
  const where = appFrame(error.stack);
  const parts = [`${nameOf(error)}${codeOf(error)}${where ? ` at ${where}` : ''}`];
  let cause = error.cause;
  while (cause instanceof Error && parts.length < 4) {
    parts.push(`caused by ${nameOf(cause)}${codeOf(cause)}`);
    cause = cause.cause;
  }
  return parts.join('; ');
}

/** Validation issues (Standard Schema, ArkType) as "<path>: <code>" for each, never their messages or values. */
export function issueSummary(issues: readonly { path?: readonly unknown[] | undefined; code?: unknown }[]): string {
  return issues
    .map((issue) => {
      const key = (issue.path ?? []).map((part) => String(part && typeof part === 'object' && 'key' in part ? part.key : part)).join('.');
      return `${key ? safe(key, 80) || '?' : '(all)'}: ${typeof issue.code === 'string' ? safe(issue.code, 40) : 'invalid'}`;
    })
    .join(', ');
}

/** Only identifier-like text: a name or code that holds anything else is left out. */
const identifier = /^[\w$.-]{1,60}$/;
const safe = (text: string, max: number) => (identifier.test(text) && text.length <= max ? text : '');

/** The class's own name (the router's error classes set no `name`), else `name`, if it is an identifier. */
function nameOf(error: Error): string {
  const own = error.constructor.name;
  const name = own && own !== 'Error' ? own : error.name;
  return safe(name, 60) || 'Error';
}

function codeOf(error: Error): string {
  const code = 'code' in error ? error.code : undefined;
  const shown = typeof code === 'string' ? safe(code, 40) : '';
  return shown ? ` ${shown}` : '';
}

/**
 * The first stack frame in this repository's code, as a path from `packages/` (source, in tests
 * and the dev server) or from the build's `server/` folder (`_ssr/<chunk>.mjs`, the deployed
 * build, which has no source maps). Library and Node frames are skipped; no such frame, nothing.
 */
function appFrame(stack: string | undefined): string {
  for (const line of (stack ?? '').split('\n')) {
    const match = /^\s+at (?:.*\()?(?:file:\/\/)?([^\s()]+):(\d+):\d+\)?$/.exec(line);
    if (!match) continue;
    const [, path = '', row = ''] = match;
    if (path.includes('/node_modules/') || path.includes('/_libs/')) continue;
    const built = path.indexOf('/.output/server/');
    const source = path.lastIndexOf('/packages/');
    const relative =
      built >= 0 ? path.slice(built + '/.output/server/'.length) : source >= 0 ? path.slice(source + '/packages/'.length) : '';
    if (relative && /^[\w$./@+-]{1,160}$/.test(relative)) return `${relative}:${row}`;
  }
  return '';
}
