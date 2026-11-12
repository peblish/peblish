/**
 * An error as one log line that cannot carry what a visitor or a peer sent. An error's message
 * often quotes its input: ArkType's "(was ...)", drizzle's `params:` list, Postgres's quoted value,
 * an SMTP refusal's recipient, a message the app built ("no such community: <name>"). So no
 * message is read, only fields whose shape cannot hold input: the class name, a short code
 * (a Postgres SQLSTATE, a Node or SMTP error code), an HTTP status or SMTP reply number, an SMTP
 * command from a fixed list, the first real frame in this repository's code as `file:line`, and
 * the same fields (no location) for up to three causes. At most 400 characters, one line.
 *
 * What a reader can tell from it: which kind of failure (class, code), where it was thrown, and
 * what it was caused by. What they cannot: the values involved; reproduce from the route and time.
 */
export function errorLine(error: unknown): string {
  if (!(error instanceof Error)) return `a thrown ${typeof error}`;
  const where = appFrame(error);
  const parts = [`${describe(error)}${where ? ` at ${where}` : ''}`];
  let cause = error.cause;
  while (cause instanceof Error && parts.length < 4) {
    parts.push(`caused by ${describe(cause)}`);
    cause = cause.cause;
  }
  const line = parts.join('; ');
  return line.length > maxLine ? `${line.slice(0, maxLine - 1)}…` : line;
}

const maxLine = 400;

/** Name, code, and the HTTP or SMTP reply number and SMTP command when they are provably not text. */
function describe(error: Error): string {
  return [nameOf(error), codeOf(error), statusOf(error), commandOf(error)].filter(Boolean).join(' ');
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
  return typeof code === 'string' ? safe(code, 40) : '';
}

/** An HTTP status or SMTP reply code (nodemailer's responseCode): an integer from 100 to 599. */
function statusOf(error: Error): string {
  for (const field of ['status', 'statusCode', 'responseCode']) {
    const value: unknown = (error as unknown as Record<string, unknown>)[field];
    if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599) return String(value);
  }
  return '';
}

/** The SMTP step a mail error happened at (nodemailer's `command`), only from this list. */
const smtpCommands: ReadonlySet<string> = new Set([
  'CONN',
  'EHLO',
  'HELO',
  'LHLO',
  'STARTTLS',
  'AUTH PLAIN',
  'AUTH LOGIN',
  'AUTH CRAM-MD5',
  'AUTH XOAUTH2',
  'MAIL FROM',
  'RCPT TO',
  'DATA',
  'RSET',
  'QUIT',
  'API',
]);

function commandOf(error: Error): string {
  const command = 'command' in error ? error.command : undefined;
  return typeof command === 'string' && smtpCommands.has(command) ? command : '';
}

/**
 * The stack's frames, only once its first line is exactly the error's name and message: the
 * message comes first in a stack and can hold anything, a line shaped like a frame included. A
 * stack whose start does not match (a message changed after the stack was taken) gives none.
 */
function framesOf(error: Error): string[] {
  const stack = typeof error.stack === 'string' ? error.stack : '';
  const name = /^[\w$.]{1,60}/.exec(stack)?.[0];
  if (!name) return [];
  const header = error.message ? `${name}: ${error.message}` : name;
  if (!stack.startsWith(`${header}\n`)) return [];
  return stack.slice(header.length + 1).split('\n');
}

/**
 * The first stack frame in this repository's code, as a path from `packages/` (source, in tests
 * and the dev server) or from the build's `server/` folder (`_ssr/<chunk>.mjs`, the deployed
 * build, which has no source maps). Library and Node frames are skipped; no such frame, nothing.
 */
function appFrame(error: Error): string {
  for (const line of framesOf(error)) {
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
