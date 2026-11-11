import { addressKey } from '@peblish/core/identity/throttle';

// What the inbox costs us, counted in fixed one-minute windows kept in memory per process: they
// limit this process's own work, which is what they protect. Four budgets, none shared, so one
// kind of traffic cannot spend another's:
//
// - Discovery (takeKeyLookup 'discovery'). Verifying a signature whose key we do not hold fetches
//   the signer's actor (signing/inbound.ts), and anyone can sign a request with a key id of their
//   choosing, so a request from a stranger is an invitation to make us fetch. One lookup is
//   charged once, to the client's address and to the host the key id names, separately: the
//   address first and alone, so a client over its small allowance is refused without spending
//   what other clients need from that host, and a flood of made-up key ids naming a real peer's
//   host from one address leaves that host's genuine new signers their turn. Then the host and
//   the total, which a spread-out flood can still spend; it is answered 429 until the window rolls.
// - Refresh (takeKeyLookup 'refresh'). The same lookup for an actor we already hold (a rotated
//   key, an actor presented under a key id we have not seen), counted apart so that discovery
//   cannot starve it and the other way round.
// - Pipeline fetches (takePipelineFetch). What processing an authenticated delivery fetches
//   (actors it names, announced objects, collections). Its own budget, so a flood of unsigned
//   requests cannot starve the work of real peers; a row that finds it spent waits and is tried
//   again (pipeline.ts).
// - Intake (takeIntake). Authenticated requests per signer and per instance, after the
//   signature is verified, so only a peer's own key spends its allowance.
// - Intake bytes (takeIntakeBytes). The bytes stored in inbox_raw per hour, per instance and in
//   all: the sustained budget behind receive.ts's pending limit, which counts only what waits.
//
// Every table is bounded: past the cap the oldest window is forgotten (a forgotten window only
// loosens one key's count, while the totals keep counting).

const windowMs = 60_000;
const maxKeys = 2000;

/**
 * Lookups of a signer's key per minute for requests that are not authenticated: per client
 * address (small: a peer's server asks from few addresses, and one new signer is one lookup), per
 * host the key id names, and in all.
 */
export const lookupBudgets = {
  discovery: { perAddress: 10, perHost: 20, total: 120 },
  refresh: { perAddress: 10, perHost: 30, total: 200 },
} as const;
export type LookupKind = keyof typeof lookupBudgets;
export const pipelinePerHostBudget = 120;
export const pipelineTotalBudget = 1200;
/** Requests per minute from one signing actor, and from all actors of one instance. */
export const perSignerRate = 300;
export const perInstanceRate = 1200;

/**
 * Bytes stored in inbox_raw per hour, from all the actors of one instance and from everyone. A
 * body is charged in full when it is stored, an upper bound of what it keeps: one the pipeline
 * rejects or skips for good is cut to a short prefix when it settles (queue.ts settle), so only
 * what applies, waits for an object or is retried keeps its bytes for the retention period
 * (core remote/prune.ts). At these budgets one process stores at most about 42 GiB for one
 * instance, and 168 GiB for all, over the 14 days; what stays of it is what applied or waits.
 */
export const intakeByteBudget = { windowMs: 60 * 60_000, perInstance: 128 * 1024 * 1024, total: 512 * 1024 * 1024 } as const;

type Window = { start: number; used: number };
type Windows = Map<string, Window>;

// On globalThis because the web build can hold two copies of a module.
const table = (name: string): Windows => {
  const holder = globalThis as unknown as Record<string, Windows | undefined>;
  return (holder[`__peblishInbox${name}`] ??= new Map());
};
const lookups: Record<LookupKind, Windows> = { discovery: table('Discoveries'), refresh: table('Refreshes') };
const pipelineFetches = table('PipelineFetches');
const intake = table('Intake');
const intakeBytes = table('IntakeBytes');

/** Counts one use of `key`; false once the window's budget is spent (a refused use counts too, so hammering stays refused). */
function spend(windows: Windows, key: string, budget: number, now: number): boolean {
  const current = windows.get(key);
  const window = current && now - current.start < windowMs ? current : { start: now, used: 0 };
  windows.delete(key);
  windows.set(key, window);
  if (windows.size > maxKeys) windows.delete(windows.keys().next().value!);
  window.used += 1;
  return window.used <= budget;
}

/** Spends one use of the shared window and of `key`'s; both are counted even when the first is spent. */
function spendBoth(windows: Windows, key: string, budgets: { key: number; total: number }, now: number): boolean {
  const total = spend(windows, '*', budgets.total, now);
  return spend(windows, key, budgets.key, now) && total;
}

/**
 * Counts one lookup of a signer's key for an unauthenticated request: `address` is the client's
 * (null when it cannot be told, which shares one window, the strictest), `host` the host the key id
 * names. False when the address's window is spent, or the host's or the shared one. An address
 * over its allowance is refused before the host and the shared window are touched.
 */
export function takeKeyLookup(kind: LookupKind, from: { address: string | null; host: string }, now = Date.now()): boolean {
  const windows = lookups[kind];
  const budget = lookupBudgets[kind];
  if (!spend(windows, `address:${addressKey(from.address ?? 'unknown')}`, budget.perAddress, now)) return false;
  return spendBoth(windows, `host:${from.host}`, { key: budget.perHost, total: budget.total }, now);
}

/** Counts one fetch to `host` made while processing an authenticated delivery. */
export const takePipelineFetch = (host: string, now = Date.now()): boolean =>
  spendBoth(pipelineFetches, `host:${host}`, { key: pipelinePerHostBudget, total: pipelineTotalBudget }, now);

/** Counts one authenticated request from `signerApId`; false when its window or its instance's is spent. */
export function takeIntake(signerApId: string, now = Date.now()): boolean {
  const instance = spend(intake, `instance:${new URL(signerApId).origin}`, perInstanceRate, now);
  return spend(intake, `signer:${signerApId}`, perSignerRate, now) && instance;
}

/** The current window of `key`, `windowMs` long, made the newest of the table (which stays bounded). */
function windowOf(windows: Windows, key: string, windowMs: number, now: number): Window {
  const current = windows.get(key);
  const window = current && now - current.start < windowMs ? current : { start: now, used: 0 };
  windows.delete(key);
  windows.set(key, window);
  if (windows.size > maxKeys) windows.delete(windows.keys().next().value!);
  return window;
}

/**
 * Charges a body of `bytes` from `signerApId` to its instance's hour and to everyone's. Null,
 * charging nothing, when it would take either over its budget (a refusal costs nothing: the
 * bytes are not stored); otherwise the refund for a body that was not stored after all.
 */
export function takeIntakeBytes(signerApId: string, bytes: number, now = Date.now()): (() => void) | null {
  const { windowMs, perInstance, total } = intakeByteBudget;
  const charged: [Window, number][] = [
    [windowOf(intakeBytes, `instance:${new URL(signerApId).origin}`, windowMs, now), perInstance],
    [windowOf(intakeBytes, '*', windowMs, now), total],
  ];
  if (charged.some(([window, budget]) => window.used + bytes > budget)) return null;
  for (const [window] of charged) window.used += bytes;
  return () => {
    for (const [window] of charged) window.used = Math.max(0, window.used - bytes);
  };
}

/** How many windows are held, across the budgets (tests). */
export const heldWindows = (): number =>
  lookups.discovery.size + lookups.refresh.size + pipelineFetches.size + intake.size + intakeBytes.size;

/** Forgets every window (tests). */
export function resetKeyFetchBudget(): void {
  lookups.discovery.clear();
  lookups.refresh.clear();
  pipelineFetches.clear();
  intake.clear();
  intakeBytes.clear();
}
