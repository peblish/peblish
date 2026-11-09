import { index, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { at, createdAt, id } from '../db/columns.ts';
import { actors } from '../db/tables/actors.ts';

// Lane ADM's tables: the CMS pages behind /<slug> (legal pages, about). Root generates the migration.

/**
 * The editable draft of each page and language. `published_revision` points at the revision
 * visitors see, or is null while the page is unpublished; saving the draft never changes it.
 */
export const pages = pgTable(
  'pages',
  {
    slug: text('slug').notNull(),
    language: text('language').notNull(),
    title: text('title').notNull(),
    bodyMd: text('body_md').notNull(),
    publishedRevision: uuid('published_revision').references(() => pageRevisions.id),
    updatedBy: uuid('updated_by')
      .notNull()
      .references(() => actors.id),
    updatedAt: at('updated_at').notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.slug, t.language] })],
);

/**
 * What was published, append-only: the title and Markdown with the operator's details filled
 * in, and when it took effect. A row is never changed or deleted, so what a visitor read on a
 * date can be shown again. No foreign key to `pages`: the history outlives a draft.
 */
export const pageRevisions = pgTable(
  'page_revisions',
  {
    id: id(),
    slug: text('slug').notNull(),
    language: text('language').notNull(),
    title: text('title').notNull(),
    bodyMd: text('body_md').notNull(),
    effectiveAt: at('effective_at').notNull(),
    publishedBy: uuid('published_by')
      .notNull()
      .references(() => actors.id),
    createdAt: createdAt(),
  },
  (t) => [index('page_revisions_page').on(t.slug, t.language, t.createdAt)],
);
