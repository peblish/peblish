import { errorLine, issueSummary } from '@peblish/core/error-line';
import { InputError } from '../server/input.ts';

/**
 * The server log entry for a route that failed (router.tsx): one physical line that never
 * carries what a visitor typed (the query string, a path parameter, a form's body, a cookie, an
 * address or a handle).
 *
 * - A search or path parameter failure (the router's SearchParamError or PathParamError, with
 *   the Standard Schema result as its cause) and a server function's refused input (InputError,
 *   server/input.ts) name each failing parameter and ArkType's code for the problem.
 * - Anything else is described by core's errorLine: class, code, the first frame in the app's
 *   code, and its causes. No message is read, whoever built it.
 *
 * Redirects and not-found never reach a route's onError, so they are never logged.
 */
export function describeRouteFailure(routeId: string, error: unknown): string {
  return `route ${routeId} failed: ${describe(error)}`;
}

export function logRouteFailure(routeId: string, error: unknown): void {
  console.error(describeRouteFailure(routeId, error));
}

function describe(error: unknown): string {
  if (error instanceof InputError) return `InputError (${error.problems})`;
  if (error instanceof Error) {
    const name = error.constructor.name;
    if (name === 'SearchParamError' || name === 'PathParamError') return `${name} (${parameterProblems(error.cause)})`;
  }
  return errorLine(error);
}

function parameterProblems(cause: unknown): string {
  if (cause && typeof cause === 'object' && 'issues' in cause && Array.isArray(cause.issues)) return issueSummary(cause.issues);
  return cause instanceof Error ? `the validator threw ${errorLine(cause).split(' ')[0]}` : 'the validator failed';
}
