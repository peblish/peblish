import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { parseShipped } from './shipped.ts';
import { pageSlugs } from './slugs.ts';
import { tokensIn } from './tokens.ts';

// The texts that ship in content/legal, from the trust-and-safety drafts, edited as the package
// README's step 3 says for the CMS handoff: no disclaimer line, no Status line, sibling links
// pointing at the live pages, no private baseline citations, no form URLs (the Report action
// and the contact email take their place). What stays are the {{TOKEN}}s the operator fills.

const folder = join(import.meta.dirname, '../../../../content/legal');
const files = readdirSync(folder).sort();
const text = (file: string) => readFileSync(join(folder, file), 'utf8');

/** The tokens publishing fills from the operator's settings and the date. */
const filled = ['{{OPERATOR_NAME}}', '{{POSTAL_ADDRESS}}', '{{JURISDICTION}}', '{{CONTACT_EMAIL}}', '{{EFFECTIVE_DATE}}'];
/** The one fact unknown until cutover day, which the operator writes into the privacy policy then. */
const kept = '{{PIEFED_ARCHIVE_DELETE_DATE}}';

describe('every shipped file follows the README step 3', () => {
  test('there is one English text for each page the drafts cover, named for its slug', () => {
    expect(files).toEqual(
      pageSlugs
        .filter((slug) => slug !== 'about')
        .map((slug) => `${slug}.en.md`)
        .sort(),
    );
  });

  for (const file of files) {
    test(`${file}: a title, the effective date line, public links only and no notes for the operator`, () => {
      const body = text(file);
      const draft = parseShipped(body);
      expect(draft?.title).toBeTruthy();
      expect(draft?.bodyMd.split('\n')[0]).toBe('Effective date: {{EFFECTIVE_DATE}}.');
      expect(body).not.toMatch(/^Not legal advice/m);
      expect(body).not.toMatch(/^Status:/m);
      expect(body).not.toMatch(/baseline/i);
      expect(body).not.toMatch(/REPORT_FORM_URL|INTIMATE_IMAGE_FORM_URL/);
      expect(body).not.toMatch(/\]\([^)]*\.md[)#]/);
      expect(body).not.toContain('—');
      // No source labels ([L], [R], [I], [I; L]): the citation links stand on their own.
      expect(body).not.toMatch(/\[[LRI](?:[;:][^\]]*)?\]/);
      // A link to another page of the instance names a page it has.
      for (const [, target] of body.matchAll(/\]\(\/([^)#]*)\)/g)) expect(pageSlugs, `${file} links to /${target}`).toContain(target);
    });
  }

  test('the five texts that need only the operator settings and the date publish once those are filled', () => {
    for (const slug of ['rules', 'moderation-policy', 'federation-policy', 'take-it-down', 'under-16'])
      for (const token of tokensIn(text(`${slug}.en.md`))) expect(filled, `${slug}.en.md`).toContain(token);
  });

  test('beyond those five, the only token is the archive deletion date in the privacy policy, so it cannot publish before cutover day', () => {
    for (const file of files)
      for (const token of tokensIn(text(file))) expect([...filled, ...(file === 'privacy.en.md' ? [kept] : [])], file).toContain(token);
    expect(text('privacy.en.md')).toContain(kept);
  });
});

describe('parseShipped', () => {
  test('takes the first heading as the title and the rest as the body', () => {
    expect(parseShipped('# Terms\nEffective date: x.\n\nBody.\n')).toEqual({ title: 'Terms', bodyMd: 'Effective date: x.\n\nBody.' });
    expect(parseShipped('\n\n# Spaced  \ntext')).toEqual({ title: 'Spaced', bodyMd: 'text' });
  });

  test('refuses a text that does not start with a heading', () => {
    expect(parseShipped('Just text')).toBeNull();
    expect(parseShipped('')).toBeNull();
    expect(parseShipped('## Not the top level')).toBeNull();
  });
});
