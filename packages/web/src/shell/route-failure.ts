/**
 * The server log entry for a route that failed (router.tsx). It must not carry what a visitor
 * typed: the query string, a form's body, a cookie, an address or a handle. So:
 *
 * - A search or path parameter failure (the router's SearchParamError, with the Standard Schema
 *   result as its cause) is one line: each failing parameter's name and ArkType's code for the
 *   problem. The issue messages are left out, as ArkType quotes the value ("was ...").
 * - Any other failure (a loader or beforeLoad error) keeps its name, code, message and stack
 *   frames, and those of its causes, except the parts known to quote input: drizzle's `params:`
 *   list and the quoted values in a Postgres message.
 *
 * Redirects and not-found never reach a route's onError, so they are never logged.
 */
export function describeRouteFailure(routeId: string, error: unknown): string {
  const head = `route ${routeId} failed:`;
  if (!(error instanceof Error)) return `${head} a thrown ${typeof error}`;
  const name = className(error);
  if (name === 'SearchParamError' || name === 'PathParamError') return `${head} ${name} (${parameterProblems(error.cause)})`;
  const frames = (error.stack ?? '').split('\n').filter((line) => line.startsWith('    at '));
  return [`${head} ${causeChain(error)}`, ...frames].join('\n');
}

/** The router's error classes set no `name`, so their constructor names them. */
function className(error: Error): string {
  const constructorName = error.constructor.name;
  return error.name === 'Error' && constructorName && constructorName !== 'Error' ? constructorName : error.name;
}

type Issue = { path?: readonly unknown[]; code?: unknown };

function parameterProblems(cause: unknown): string {
  if (!cause || typeof cause !== 'object' || !('issues' in cause) || !Array.isArray(cause.issues)) {
    return cause instanceof Error ? `the validator threw ${className(cause)}` : 'the validator failed';
  }
  return cause.issues
    .map((issue: Issue) => {
      const key = (issue.path ?? []).map((part) => String(part && typeof part === 'object' && 'key' in part ? part.key : part)).join('.');
      return `${key || '(all)'}: ${typeof issue.code === 'string' ? issue.code : 'invalid'}`;
    })
    .join(', ');
}

/** "Name code: message; caused by ...", three causes deep at most. */
function causeChain(error: Error): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error && parts.length < 4) {
    const code = 'code' in current && typeof current.code === 'string' ? ` ${current.code}` : '';
    parts.push(`${className(current)}${code}: ${safeMessage(current)}`);
    current = current.cause;
  }
  return parts.join('; caused by ');
}

function safeMessage(error: Error): string {
  // DrizzleQueryError: "Failed query: <sql>\nparams: <values>". The SQL has placeholders only.
  if ('query' in error && typeof error.query === 'string' && 'params' in error) return `Failed query: ${error.query}`;
  // PostgresError quotes the offending value: invalid input syntax for type uuid: "<value>".
  if ('severity' in error) return error.message.replace(/"[^"]*"/g, '"…"');
  return error.message;
}
