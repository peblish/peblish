import type { RefusalReason } from '@peblish/schema/refusal';
import { siteSettings as contract } from '@peblish/schema/site-settings';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { forNoKeyUpdate, forShare } from '../authz/policy.ts';
import type { Queryable } from '../db/read.ts';
import { siteSettings } from '../db/tables/site.ts';
import { oneLine, fillTokens, utcDate } from './tokens.ts';
import { pages } from './tables.ts';

/** The setting keys that fill the tokens. */
const operatorKeys = ['operator.name', 'operator.address', 'operator.jurisdiction', 'contact.email'] as const;

/** The operator's details as stored (the contract default when a row is missing), read FOR SHARE in key order under `lock` so a change to them waits for a publish in flight. */
async function operatorDetails(db: Queryable, lock: boolean) {
  const rows = await forShare(
    db
      .select({ key: siteSettings.key, value: siteSettings.value })
      .from(siteSettings)
      .where(inArray(siteSettings.key, [...operatorKeys]))
      // Key order by code point, as the settings writer (settings/write.ts) sorts and locks them, so the two cannot deadlock.
      .orderBy(sql`${siteSettings.key} collate "C"`),
    lock,
  );
  const stored = new Map(rows.map(({ key, value }) => [key, value]));
  const read = <K extends (typeof operatorKeys)[number]>(key: K) =>
    stored.has(key) ? contract[key].schema.assert(stored.get(key)) : contract[key].default;
  return {
    name: read('operator.name'),
    address: read('operator.address'),
    jurisdiction: read('operator.jurisdiction'),
    email: read('contact.email'),
  };
}

/**
 * What publishing a draft would put live: its title and Markdown with the operator's details
 * and the date filled in, or the reason it cannot be published. The draft row is read FOR NO
 * KEY UPDATE under `lock` (publishing and unpublishing update it) and the details FOR SHARE,
 * so neither a save nor a change of details slips in between the check and the write.
 */
export async function prepareRevision(
  db: Queryable,
  page: { slug: string; language: string },
  lock: boolean,
  now = new Date(),
): Promise<{ ok: true; title: string; bodyMd: string } | { ok: false; reason: RefusalReason; unresolved: string[] }> {
  const [draft] = await forNoKeyUpdate(
    db
      .select({ title: pages.title, bodyMd: pages.bodyMd })
      .from(pages)
      .where(and(eq(pages.slug, page.slug), eq(pages.language, page.language))),
    lock,
  );
  if (!draft) return { ok: false, reason: 'target.not_found', unresolved: [] };
  const operator = await operatorDetails(db, lock);
  const values = {
    OPERATOR_NAME: operator.name,
    POSTAL_ADDRESS: oneLine(operator.address),
    JURISDICTION: operator.jurisdiction,
    CONTACT_EMAIL: operator.email,
    EFFECTIVE_DATE: utcDate(now),
  };
  const title = fillTokens(draft.title, values);
  const body = fillTokens(draft.bodyMd, values);
  const unresolved = [...new Set([...title.unresolved, ...body.unresolved])];
  if (unresolved.length > 0) return { ok: false, reason: 'page.unresolved_tokens', unresolved };
  return { ok: true, title: title.text, bodyMd: body.text };
}
