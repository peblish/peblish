import type { Principal } from '@peblish/schema/authz';
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { authorize } from '../authz/authorize.ts';
import { db } from '../db/read.ts';
import { authUser } from '../db/tables/auth.ts';
import { siteSettings } from '../db/tables/site.ts';
import { modlog } from '../db/tables/moderation.ts';
import { writer } from '../db/write.ts';
import { updateSettingsAs } from '../settings/write.ts';
import { truncateAll } from '../testing/db.ts';
import { gate, grantFor, outboxEvents, someoneWaitsOnALock, writeCounts } from '../testing/seed-az.ts';
import { person, remote, seedCommunityWorld } from '../testing/seed-f.ts';
import { tx } from '../tx/tx.ts';
import { Refused } from '../tx/refused.ts';
import { publishPage, publishPageAs, unpublishPage, unpublishPageAs } from './publish.ts';
import { listPages, publishedPages, readDraft, readPublishedPage, unresolvedTokens } from './read.ts';
import { savePage, savePageAs, seedShippedPages } from './save.ts';
import { prepareRevision } from './prepare.ts';
import { pageRevisions, pages } from './tables.ts';

beforeEach(truncateAll);

const world = async () => {
  const w = await seedCommunityWorld();
  return { ...w, admin: person(w.people.admin.id, 'admin') };
};
const operator = {
  'operator.name': 'Test Operator',
  'operator.address': 'Main Street 1\n10115 Berlin',
  'operator.jurisdiction': 'Berlin',
  'contact.email': 'hello@feddit.test',
} as const;
const draft = {
  title: 'Community rules',
  bodyMd: 'Run by {{OPERATOR_NAME}} at {{POSTAL_ADDRESS}}, {{JURISDICTION}}. Write to {{CONTACT_EMAIL}}. Effective {{EFFECTIVE_DATE}}.',
};
const rules = { slug: 'rules', language: 'en' };

async function fill(admin: Principal) {
  const result = await updateSettingsAs(admin, operator);
  if (!result.ok) throw new Error(result.reason);
}
async function saved(admin: Principal, page = rules, content = draft) {
  const result = await savePageAs(admin, page, content);
  if (!result.ok) throw new Error(result.reason);
}

describe('page policies', () => {
  test('only an admin with two-factor, for a known page: each other principal gets its exact reason', async () => {
    const { people, admin } = await world();
    await saved(admin);
    for (const action of ['page.save', 'page.publish', 'page.unpublish'] as const) {
      const table: [string, Principal, string][] = [
        ['anonymous', { kind: 'anonymous' }, 'auth.required'],
        ['a local user', person(people.user.id), 'auth.admin_required'],
        ['an admin the database has without two-factor', person(people.adminWithoutTwoFactor.id, 'admin'), 'admin.two_factor_required'],
        ['a remote actor', remote(people.remoteUser.id), 'auth.admin_required'],
      ];
      for (const [who, principal, reason] of table)
        expect(await authorize(action, principal, rules), `${action}: ${who}`).toEqual({ ok: false, reason });
      expect(await authorize(action, admin, { slug: 'nope', language: 'en' }), `${action}: unknown slug`).toEqual({
        ok: false,
        reason: 'target.not_found',
      });
      expect(await authorize(action, admin, { slug: 'rules', language: 'fr' }), `${action}: unknown language`).toEqual({
        ok: false,
        reason: 'target.not_found',
      });
    }
    expect(await authorize('page.save', admin, rules)).toMatchObject({
      ok: true,
      grant: { authority: { kind: 'site-admin', actorId: people.admin.id } },
    });
  });

  test('an admin whose two-factor went off after authorize() is refused by the recheck, for save, publish and unpublish, with nothing written', async () => {
    const { people, admin } = await world();
    await fill(admin);
    await saved(admin);
    await publishPageAs(admin, rules);
    const grants = {
      save: await grantFor('page.save', admin, rules),
      publish: await grantFor('page.publish', admin, rules),
      unpublish: await grantFor('page.unpublish', admin, rules),
    };
    await writer().update(authUser).set({ twoFactorEnabled: false }).where(eq(authUser.id, people.admin.userId!));
    const before = await writeCounts();
    const refused = new Refused('page.save', 'auth.admin_required');
    await expect(savePage(grants.save, { draft: { title: 'Changed', bodyMd: 'x' } })).rejects.toThrowError(refused);
    await expect(publishPage(grants.publish, undefined)).rejects.toThrowError(new Refused('page.publish', 'auth.admin_required'));
    await expect(unpublishPage(grants.unpublish, undefined)).rejects.toThrowError(new Refused('page.unpublish', 'auth.admin_required'));
    expect(await writeCounts()).toEqual(before);
    expect((await readDraft('rules', 'en'))?.title).toBe('Community rules');
  });
});

describe('savePage', () => {
  test('a draft is saved, created for a new language, and refused when empty or too long; nothing is logged', async () => {
    const { admin, people } = await world();
    expect(await savePageAs(admin, rules, draft)).toEqual({ ok: true, saved: true });
    expect(await savePageAs(admin, { slug: 'rules', language: 'de' }, { title: 'Regeln', bodyMd: '' })).toEqual({ ok: true, saved: true });
    expect(await readDraft('rules', 'de')).toMatchObject({ title: 'Regeln', bodyMd: '' });
    for (const bad of [
      { title: '', bodyMd: 'x' },
      { title: 'x'.repeat(121), bodyMd: 'x' },
      { title: 'x', bodyMd: 'y'.repeat(50_001) },
    ])
      expect(await savePageAs(admin, rules, bad)).toEqual({ ok: false, reason: 'page.invalid' });
    expect(await db().select().from(modlog)).toEqual([]);
    expect(await outboxEvents()).toEqual([
      { type: 'page.changed', v: 1, slug: 'rules', language: 'en', change: 'saved', revisionId: null, actorId: people.admin.id },
      { type: 'page.changed', v: 1, slug: 'rules', language: 'de', change: 'saved', revisionId: null, actorId: people.admin.id },
    ]);
  });

  test('saving the same text again writes nothing', async () => {
    const { admin } = await world();
    await saved(admin);
    const before = await writeCounts();
    expect(await savePageAs(admin, rules, draft)).toEqual({ ok: true, saved: false });
    expect(await writeCounts()).toEqual(before);
  });
});

describe('publishPage', () => {
  test('stores a revision with the operator details and the date filled in, points the page at it, and logs and announces it in one transaction', async () => {
    const { admin, people } = await world();
    await fill(admin);
    await saved(admin);
    const result = await publishPageAs(admin, rules);
    if (!result.ok) throw new Error(result.reason);
    const [revision] = await db().select().from(pageRevisions);
    const today = new Date().toISOString().slice(0, 10);
    expect(revision).toMatchObject({
      id: result.revisionId,
      slug: 'rules',
      language: 'en',
      title: 'Community rules',
      bodyMd: `Run by Test Operator at Main Street 1, 10115 Berlin, Berlin. Write to hello@feddit.test. Effective ${today}.`,
      publishedBy: people.admin.id,
    });
    expect(revision?.bodyMd).not.toMatch(/\{\{/);
    // The draft keeps its tokens; only the revision is filled.
    expect((await readDraft('rules', 'en'))?.bodyMd).toBe(draft.bodyMd);
    const [row] = await db().select({ revision: pages.publishedRevision }).from(pages);
    expect(row?.revision).toBe(result.revisionId);
    const entries = await db().select().from(modlog).where(eq(modlog.action, 'page.publish'));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actorId: people.admin.id,
      communityId: null,
      targetActorId: null,
      public: false,
      details: { public: false, page: { slug: 'rules', language: 'en', revision: result.revisionId } },
    });
    expect((await outboxEvents()).at(-1)).toEqual({
      type: 'page.changed',
      v: 1,
      slug: 'rules',
      language: 'en',
      change: 'published',
      revisionId: result.revisionId,
      actorId: people.admin.id,
    });
    const [same] = await db().execute<{ same: boolean }>(
      sql`select (select (tx_id::text::numeric % 4294967296)::text from outbox order by id desc limit 1) = (select xmin::text from page_revisions) as same`,
    );
    expect(same?.same).toBe(true);
  });

  test('a leftover token or an empty operator detail refuses the publish with page.unresolved_tokens and writes nothing', async () => {
    const { admin } = await world();
    await saved(admin, rules, draft);
    // The operator details are still empty.
    expect(await publishPageAs(admin, rules)).toEqual({ ok: false, reason: 'page.unresolved_tokens' });
    await fill(admin);
    await saved(admin, { slug: 'dmca', language: 'en' }, { title: 'DMCA', bodyMd: 'Agent: {{DMCA_AGENT_NAME}}. {{OPERATOR_NAME}}' });
    const counts = async () => (await writeCounts()) ?? { modlog: 0, outbox: 0 };
    const before = await counts();
    expect(await publishPageAs(admin, { slug: 'dmca', language: 'en' })).toEqual({ ok: false, reason: 'page.unresolved_tokens' });
    expect(await counts()).toEqual(before);
    await updateSettingsAs(admin, { 'contact.email': '' });
    const afterChange = await counts();
    expect(await publishPageAs(admin, rules)).toEqual({ ok: false, reason: 'page.unresolved_tokens' });
    expect(await counts()).toEqual(afterChange);
    expect(await db().select().from(pageRevisions)).toEqual([]);
    expect(await publishedPages('en')).toEqual([]);
  });

  test('a value that looks like a token is written as text, never filled again', async () => {
    const { admin } = await world();
    await updateSettingsAs(admin, { ...operator, 'operator.name': '{{CONTACT_EMAIL}}' });
    await saved(admin);
    const result = await publishPageAs(admin, rules);
    if (!result.ok) throw new Error(result.reason);
    const [revision] = await db().select({ bodyMd: pageRevisions.bodyMd }).from(pageRevisions);
    expect(revision?.bodyMd).toContain('Run by {{CONTACT_EMAIL}} at');
  });

  test('a draft edit leaves the live revision alone, and publishing again replaces it', async () => {
    const { admin } = await world();
    await fill(admin);
    await saved(admin);
    await publishPageAs(admin, rules);
    const live = () => readPublishedPage('rules', 'en');
    const first = await live();
    expect(first?.title).toBe('Community rules');
    await saved(admin, rules, { title: 'Rules, edited', bodyMd: 'New text for {{OPERATOR_NAME}}.' });
    expect(await live()).toEqual(first);
    expect((await listPages()).find((row) => row.slug === 'rules' && row.language === 'en')?.status).toBe('changed');
    await publishPageAs(admin, rules);
    expect(await live()).toMatchObject({ title: 'Rules, edited', bodyMd: 'New text for Test Operator.' });
    expect(await db().select().from(pageRevisions)).toHaveLength(2);
    expect((await listPages()).find((row) => row.slug === 'rules' && row.language === 'en')?.status).toBe('published');
  });

  test('a missing draft is target.not_found', async () => {
    const { admin } = await world();
    expect(await publishPageAs(admin, rules)).toEqual({ ok: false, reason: 'target.not_found' });
  });
});

describe('unpublishPage', () => {
  test('a draft that was never published is page.not_published; a published one goes off the site and keeps its draft and revisions', async () => {
    const { admin, people } = await world();
    await fill(admin);
    await saved(admin);
    expect(await unpublishPageAs(admin, rules)).toEqual({ ok: false, reason: 'page.not_published' });
    await publishPageAs(admin, rules);
    expect(await unpublishPageAs(admin, rules)).toEqual({ ok: true });
    expect(await readPublishedPage('rules', 'en')).toBeNull();
    expect(await readDraft('rules', 'en')).not.toBeNull();
    expect(await db().select().from(pageRevisions)).toHaveLength(1);
    expect((await listPages()).find((row) => row.slug === 'rules' && row.language === 'en')?.status).toBe('draft');
    expect(
      await db().select({ action: modlog.action, actorId: modlog.actorId }).from(modlog).where(eq(modlog.action, 'page.unpublish')),
    ).toEqual([{ action: 'page.unpublish', actorId: people.admin.id }]);
    expect(await unpublishPageAs(admin, rules)).toEqual({ ok: false, reason: 'page.not_published' });
  });
});

describe('what a reader gets', () => {
  test("a reader's language first, else English, and nothing for a page that is not live", async () => {
    const { admin } = await world();
    await fill(admin);
    const en = { slug: 'terms', language: 'en' };
    await saved(admin, en, { title: 'Terms', bodyMd: 'English terms.' });
    await saved(admin, { slug: 'terms', language: 'de' }, { title: 'Nutzungsbedingungen', bodyMd: 'Deutsche Bedingungen.' });
    await saved(admin, { slug: 'about', language: 'de' }, { title: 'Über uns', bodyMd: 'Nur deutsch.' });
    expect(await publishedPages('de')).toEqual([]);
    await publishPageAs(admin, en);
    await publishPageAs(admin, { slug: 'terms', language: 'de' });
    await publishPageAs(admin, { slug: 'about', language: 'de' });
    expect((await publishedPages('de')).map(({ slug, language }) => `${slug}/${language}`)).toEqual(['terms/de', 'about/de']);
    expect((await publishedPages('en')).map(({ slug, language }) => `${slug}/${language}`)).toEqual(['terms/en']);
    expect((await publishedPages('fr')).map(({ slug, language }) => `${slug}/${language}`)).toEqual(['terms/en']);
    expect(await readPublishedPage('rules', 'en')).toBeNull();
  });
});

describe('seedShippedPages', () => {
  const shipped = [
    { slug: 'rules', draft: { title: 'Rules', bodyMd: 'Shipped rules.' } },
    { slug: 'terms', draft: { title: 'Terms', bodyMd: 'Shipped terms.' } },
  ] as const;

  test('adds the drafts that are missing, as English, and never overwrites one that exists', async () => {
    const { admin } = await world();
    expect(await seedShippedPages(admin, shipped)).toEqual({ ok: true, added: 2 });
    await saved(admin, rules, { title: 'My rules', bodyMd: 'Edited by the admin.' });
    expect(await seedShippedPages(admin, shipped)).toEqual({ ok: true, added: 0 });
    expect(await readDraft('rules', 'en')).toMatchObject({ title: 'My rules', bodyMd: 'Edited by the admin.' });
    expect(await readDraft('terms', 'en')).toMatchObject({ title: 'Terms' });
    await writer().delete(pages).where(eq(pages.slug, 'terms'));
    expect(await seedShippedPages(admin, shipped)).toEqual({ ok: true, added: 1 });
    expect(await readDraft('rules', 'en')).toMatchObject({ title: 'My rules' });
  });

  test('is refused for anyone but an admin with two-factor, and adds nothing', async () => {
    const { people } = await world();
    expect(await seedShippedPages(person(people.user.id), shipped)).toEqual({ ok: false, reason: 'auth.admin_required' });
    expect(await db().select().from(pages)).toEqual([]);
  });
});

describe('a publish and a change of operator details at once', () => {
  test('changing a detail waits for a rechecked publish in flight, so a page is never published with half-old details', async () => {
    const { admin } = await world();
    await fill(admin);
    await saved(admin);
    // As after migrate: the setting rows exist, so there is something to lock.
    const grant = await grantFor('page.publish', admin, rules);
    const holding = gate();
    const release = gate();
    const publishing = tx(async (t) => {
      const revision = await publishPage.within(t, grant, undefined);
      holding.open();
      await release.opened;
      return revision;
    });
    await holding.opened;
    let changed = false;
    const changing = updateSettingsAs(admin, { 'operator.name': 'Someone Else' }).then(() => (changed = true));
    try {
      await expect.poll(someoneWaitsOnALock).toBe(true);
      expect(changed).toBe(false);
    } finally {
      release.open();
    }
    const { revisionId } = await publishing;
    await changing;
    const [revision] = await db().select({ bodyMd: pageRevisions.bodyMd }).from(pageRevisions).where(eq(pageRevisions.id, revisionId));
    expect(revision?.bodyMd).toContain('Test Operator');
    expect(revision?.bodyMd).not.toContain('Someone Else');
  });
});

describe('a publish and a settings save lock the operator rows the same way round', () => {
  test('the publish reads them in key order, so a writer locking in key order never deadlocks with it', async () => {
    const { admin } = await world();
    await fill(admin);
    await saved(admin);
    // Put contact.email (first in key order) after operator.name (last) in the table, so a scan
    // that is not sorted would lock operator.name first.
    const [email] = await writer().delete(siteSettings).where(eq(siteSettings.key, 'contact.email')).returning();
    await writer().insert(siteSettings).values(email!);
    const placed = await db().execute<{ key: string }>(
      sql`select key from site_settings where key in ('contact.email', 'operator.name') order by ctid`,
    );
    expect(placed.map((row) => row.key)).toEqual(['operator.name', 'contact.email']);

    // The writer holds contact.email, as settings/write.ts does when it saves it with operator.name.
    const second = gate();
    const writing = writer().transaction(async (t) => {
      await t.select().from(siteSettings).where(eq(siteSettings.key, 'contact.email')).for('no key update');
      await second.opened;
      await t.select().from(siteSettings).where(eq(siteSettings.key, 'operator.name')).for('no key update');
    });
    // The publish's read, made to scan the table rather than walk the key index.
    const publishing = writer().transaction(async (t) => {
      await t.execute(sql`set local enable_indexscan = off`);
      await t.execute(sql`set local enable_bitmapscan = off`);
      await t.execute(sql`set local enable_indexonlyscan = off`);
      return prepareRevision(t, rules, true);
    });
    await expect.poll(someoneWaitsOnALock).toBe(true);
    second.open();
    await writing;
    expect(await publishing).toMatchObject({ ok: true });
  });
});

describe('unresolvedTokens', () => {
  test('names what a publish would still find to fill, and nothing once the details are in', async () => {
    const { admin } = await world();
    await saved(admin, rules, { title: 'Rules', bodyMd: '{{OPERATOR_NAME}} {{DMCA_AGENT_NAME}} {{CONTACT_EMAIL}}' });
    expect(await unresolvedTokens('rules', 'en')).toEqual(['{{OPERATOR_NAME}}', '{{DMCA_AGENT_NAME}}', '{{CONTACT_EMAIL}}']);
    await updateSettingsAs(admin, { 'operator.name': 'Op', 'contact.email': 'a@b.test' });
    expect(await unresolvedTokens('rules', 'en')).toEqual(['{{DMCA_AGENT_NAME}}']);
    expect(await unresolvedTokens('rules', 'de')).toEqual([]);
  });
});
