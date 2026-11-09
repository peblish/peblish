import type { Uuid } from '@peblish/schema/ids';
import { eq } from 'drizzle-orm';
import type { WriteTx } from '../db/write.ts';
import { communityLanguages } from '../db/tables/actors.ts';
import { renderMarkdown } from '../markdown/render.ts';
import type { CommunityFields } from './input.ts';
import { communityRules } from './tables.ts';

// What community.create and community.update share (lane F): Markdown to HTML and the two
// lists that hang off the community. They run inside the mutation's transaction, after the
// community's actor row is locked.

/**
 * Markdown source and its HTML. The HTML is the federation form: relative links resolve
 * against the instance origin and images are left as written (the MD lane's note); pages
 * render the source themselves. Empty text is stored as null.
 */
export function markdown(source: string | null | undefined, origin: string): { md: string | null; html: string | null } {
  if (!source) return { md: null, html: null };
  return { md: source, html: renderMarkdown(source, { baseOrigin: origin }).html };
}

/** Replaces the community's languages with `languages`, each once. */
export async function replaceLanguages(db: WriteTx, communityId: Uuid, languages: readonly string[]): Promise<void> {
  await db.delete(communityLanguages).where(eq(communityLanguages.communityId, communityId));
  const unique = [...new Set(languages)];
  if (unique.length > 0) await db.insert(communityLanguages).values(unique.map((language) => ({ communityId, language })));
}

/** Replaces the community's rules with `rules`, numbered from 1 in the order given. */
export async function replaceRules(
  db: WriteTx,
  communityId: Uuid,
  origin: string,
  rules: NonNullable<CommunityFields['rules']>,
): Promise<void> {
  await db.delete(communityRules).where(eq(communityRules.communityId, communityId));
  if (rules.length === 0) return;
  await db.insert(communityRules).values(
    rules.map((rule, index) => {
      const body = markdown(rule.body, origin);
      return { communityId, position: index + 1, title: rule.title, bodyMd: body.md, bodyHtml: body.html };
    }),
  );
}
