import { reportCategories } from '@peblish/core/reports/categories';
import { describe, expect, test } from 'vitest';
import { catalogues } from '../../../registry/i18n.gen.ts';
import { reportErrors } from './errors.ts';

const { en, de } = catalogues.reports;

describe('the reports catalogue', () => {
  test('has the same keys in English and German', () => {
    expect(Object.keys(de).sort()).toEqual(Object.keys(en).sort());
  });

  test('names every category with its help line, and every error the pages can show', () => {
    const keys = new Set(Object.keys(en));
    const missing = [
      ...reportCategories.flatMap((key) => [`category.${key}`, `category.${key}.help`]),
      ...reportErrors.map((code) => `error.${code}`),
    ].filter((key) => !keys.has(key));
    expect(missing).toEqual([]);
  });
});
