// THE SSRF SEAM. Every outbound request federation makes goes through this module and nothing
// else. It re-exports lane B2's resolver, address predicate and redirect checks from core, which
// are the single implementation of "a public address only". There is no switch that lets a private
// address through; the live lab overlays this one file with a client of its own, outside product code.
export { BlockedDestinationError, FetchTimeoutError, safeFetch } from '@peblish/core/net/fetch';
export type { SafeFetchInit, SafeResponse } from '@peblish/core/net/fetch';
