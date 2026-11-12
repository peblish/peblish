import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The request the web process is serving, as its endpoint (method and route template, web
 * server/endpoint.ts), or nothing in the worker and outside requests. The log boundary starts
 * each line with it; library code that runs both in the worker and under a request reads
 * `onRequestPath()` to leave out what a request could have chosen (a typed host, a URL, a path)
 * while the worker keeps naming the peer. On globalThis: the web build carries two copies of a
 * module both the Nitro entry and the SSR bundle import.
 */
const holder = globalThis as { __peblishLogScope?: AsyncLocalStorage<string> };
export const requestScope = (holder.__peblishLogScope ??= new AsyncLocalStorage<string>());

/** Whether this code runs while the web process serves a request. */
export const onRequestPath = (): boolean => requestScope.getStore() !== undefined;
