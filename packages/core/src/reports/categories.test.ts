import { describe, expect, it } from 'vitest';
import { adminOnly, audienceOf, categoriesFor, mayFederate, reportCategories } from './categories.ts';
import { removalStatement } from './statement.ts';

describe('report categories', () => {
  it('match the table: eleven keys, admin-only ones never reach moderators and never federate', () => {
    expect(reportCategories).toHaveLength(11);
    const adminKeys = reportCategories.filter(adminOnly);
    expect(adminKeys).toEqual(['child_safety', 'terror_violence', 'intimate_image', 'copyright', 'under_16']);
    for (const kind of ['post', 'comment', 'actor'] as const) {
      for (const category of categoriesFor(kind)) {
        if (adminOnly(category)) {
          expect(audienceOf(category, kind)).toBe('admins');
          expect(mayFederate(category, kind)).toBe(false);
        }
      }
    }
  });

  it('filter by target kind and send every person or community report to the admins', () => {
    expect(categoriesFor('post')).not.toContain('under_16');
    expect(categoriesFor('actor')).toContain('under_16');
    expect(categoriesFor('actor')).not.toContain('sexual_content');
    expect(categoriesFor('actor')).not.toContain('copyright');
    expect(audienceOf('spam', 'actor')).toBe('admins');
    expect(audienceOf('spam', 'post')).toBe('moderators');
    expect(mayFederate('spam', 'actor')).toBe(false);
    expect(mayFederate('spam', 'comment')).toBe(true);
  });
});

describe('removalStatement', () => {
  const base = {
    caseNumber: 12,
    decidedAt: new Date('2026-11-09T10:00:00Z'),
    operator: { name: 'Feddit', contactEmail: 'safety@example.test' },
    item: { kind: 'post' as const, apId: 'https://feddit.test/post/1' },
    rule: 6,
    explanation: 'The link leads to a page that collects card numbers.',
  };

  it('fills the template fields and names the review route', () => {
    const result = removalStatement(base);
    if (!result.ok) throw new Error('expected a statement');
    expect(result.text).toContain('Case: #12');
    expect(result.text).toContain('https://feddit.test/post/1');
    expect(result.text).toContain('community rule 6');
    expect(result.text).toContain('Reply to safety@example.test');
    expect(result.text).not.toMatch(/reporter/i);
  });

  it('needs an explanation and a rule from 1 to 7', () => {
    expect(removalStatement({ ...base, explanation: '   ' })).toEqual({ ok: false, reason: 'report.reason_required' });
    expect(removalStatement({ ...base, rule: 8 })).toEqual({ ok: false, reason: 'report.reason_required' });
    expect(removalStatement({ ...base, explanation: 'x'.repeat(2001) })).toEqual({ ok: false, reason: 'report.reason_required' });
  });
});
