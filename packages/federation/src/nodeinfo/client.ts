import { type } from 'arktype';
import { db } from '@peblish/core/db/read';
import { instances } from '@peblish/core/db/tables/instances';
import { storeInstanceSoftware } from '@peblish/core/remote/instances';
import { eq } from 'drizzle-orm';
import { fetchJson, type Fetcher } from '../actors/document.ts';
import { FederationPaused } from '../actors/federation-switch.ts';
import { importGrant } from '../actors/grants.ts';

// What software a peer runs, from its NodeInfo. The delivery code picks the Announce shape
// from it, so it is fetched when we first meet an instance (its actor is stored) and again
// when a day has passed, and stored in instances.software.

const nodeinfoRel = /^http:\/\/nodeinfo\.diaspora\.software\/ns\/schema\/(\d+\.\d+)$/;

const Discovery = type({ links: type({ rel: 'string', href: 'string.url' }).array() });
const Document = type({ software: { name: 'string', 'version?': 'string' } });

/** How long a stored answer is trusted, and how long a failed check is not repeated. */
export const nodeInfoMaxAgeMs = 24 * 60 * 60 * 1000;
export const nodeInfoRetryMs = 10 * 60 * 1000;

/** The longest software name and version kept; a peer chooses both, and both are stored and compared. */
export const softwareFieldMax = 64;

/**
 * What a peer's NodeInfo software fields become before they are stored. The name is NodeInfo's
 * own pattern, lowercase letters, digits and hyphens, so anything else is dropped; a name with
 * nothing left is no software. The version keeps printable ASCII only. Both are cut at
 * `softwareFieldMax`.
 */
export function cleanSoftware(name: string, version: string | undefined): { software: string; version: string | null } {
  const software = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, softwareFieldMax);
  if (!software) throw new TypeError('NodeInfo names no usable software');
  const cleaned = (version ?? '')
    .replace(/[^\x20-\x7e]/g, '')
    .trim()
    .slice(0, softwareFieldMax);
  return { software, version: cleaned || null };
}

/** The newest NodeInfo document `origin` links, with the software it names (cleaned, see cleanSoftware). */
export async function fetchNodeInfo(origin: string, fetch: Fetcher): Promise<{ software: string; version: string | null }> {
  const discovery = Discovery((await fetchJson(`${origin}/.well-known/nodeinfo`, fetch, 'application/json')).json);
  if (discovery instanceof type.errors) throw new TypeError(`${origin} has no NodeInfo links`);
  const [newest] = discovery.links
    .flatMap(({ rel, href }) => {
      const version = nodeinfoRel.exec(rel)?.[1];
      return version ? [{ version: Number(version), href }] : [];
    })
    // A document is read only from the host that linked it.
    .filter(({ href }) => new URL(href).origin === new URL(origin).origin)
    .sort((a, b) => b.version - a.version);
  if (!newest) throw new TypeError(`${origin} links no NodeInfo 2.x document`);
  const document = Document((await fetchJson(newest.href, fetch, 'application/json')).json);
  if (document instanceof type.errors) throw new TypeError(`${newest.href} names no software`);
  return cleanSoftware(document.software.name, document.software.version);
}

// Failed checks, per origin, so an unreachable or NodeInfo-less peer is asked once in a while,
// not on every actor fetch. Per process; on globalThis because the web build can hold two copies
// of a module. An entry lives for `nodeInfoRetryMs` and the map holds at most `failuresMax`
// origins (a peer chooses the hosts of the actors it makes us resolve), the oldest going first.
const failures = ((globalThis as { __peblishNodeInfoFailures?: Map<string, number> }).__peblishNodeInfoFailures ??= new Map());
const failuresMax = 5_000;
// Reads in flight, per origin: callers that arrive while one is running share it, so a burst of
// actors from one new server is one discovery request, not one each.
const reading = ((globalThis as { __peblishNodeInfoReads?: Map<string, Promise<void>> }).__peblishNodeInfoReads ??= new Map());

/** Whether a check of `origin` failed within the retry window; an older entry is dropped. */
function recentlyFailed(origin: string, now: number): boolean {
  const failedAt = failures.get(origin);
  if (failedAt === undefined) return false;
  if (now - failedAt < nodeInfoRetryMs) return true;
  failures.delete(origin);
  return false;
}

/** Remembers a failed check, and forgets expired entries and, past the cap, the oldest. */
function recordFailure(origin: string, now: number): void {
  failures.delete(origin);
  failures.set(origin, now);
  for (const [key, failedAt] of failures) {
    if (now - failedAt < nodeInfoRetryMs && failures.size <= failuresMax) break;
    failures.delete(key);
  }
}

/** How many origins have a failed check on record (tests). */
export const nodeInfoFailureCount = (): number => failures.size;

/** Forgets every failed check (tests). */
export function forgetNodeInfoFailures(): void {
  failures.clear();
}

async function refresh(origin: string, fetch: Fetcher, now: number): Promise<void> {
  const [row] = await db()
    .select({ software: instances.software, checkedAt: instances.updatedAt })
    .from(instances)
    .where(eq(instances.domain, new URL(origin).host));
  if (row?.software && now - row.checkedAt.getTime() < nodeInfoMaxAgeMs) return;
  if (recentlyFailed(origin, now)) return;
  try {
    const { software, version } = await fetchNodeInfo(origin, fetch);
    await storeInstanceSoftware(await importGrant('remote.instance_store', { origin }), { software, version });
    failures.delete(origin);
  } catch (error) {
    // Nothing was asked, so the peer did not fail: the next check after the pause asks it.
    if (error instanceof FederationPaused) return;
    recordFailure(origin, now);
    console.warn(`nodeinfo: ${origin}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Brings instances.software up to date for the peer at `origin` unless it was checked within
 * `nodeInfoMaxAgeMs`. A check that fails stores nothing and is not repeated for ten minutes; it
 * never throws, because no caller can act on it: an instance with unknown software gets the
 * default Announce shape. Concurrent calls for one origin share one check.
 */
export function refreshInstanceSoftware(origin: string, { fetch, now = Date.now() }: { fetch: Fetcher; now?: number }): Promise<void> {
  const running = reading.get(origin);
  if (running) return running;
  const work = refresh(origin, fetch, now).finally(() => reading.delete(origin));
  reading.set(origin, work);
  return work;
}
