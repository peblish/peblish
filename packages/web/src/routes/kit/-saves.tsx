import { EmptyState } from '@peblish/ui/components/empty-state';
import { FeedRowActions } from '@peblish/ui/components/feed-row-actions';
import { Link } from '@peblish/ui/components/link';
import { Pager } from '@peblish/ui/components/pager';
import { useTranslate } from '../../i18n/use-translate.ts';
import { SaveFormView } from '../saved/-ui/save-form.tsx';
import type { Composition } from './-states.tsx';

// The saves lane's state pages (/kit/<key>), registered in -states.tsx: the post page's Save and Unsave
// with its status and a failure, a Saved row's Unsave, the feed row menu with Save (and its plain form
// before hydration), and the Saved page's empty state and its page links. The words come from the saves
// and feeds catalogues.

const sample = {
  postId: '019aaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
  title: 'Which sort do you leave your home feed on?',
  back: '/kit/post-save',
};

function PostSave({ saved = false, pending, failed }: { saved?: boolean; pending?: boolean; failed?: boolean }) {
  const { t } = useTranslate();
  return (
    <SaveFormView
      {...sample}
      saved={saved}
      pending={pending}
      said={saved ? t('saves', 'status.saved') : ''}
      error={failed ? t('saves', 'status.saveFailed') : undefined}
    />
  );
}

function RowUnsave({ pending, failed }: { pending?: boolean; failed?: boolean }) {
  const { t } = useTranslate();
  return (
    <span className="pb-post__actions">
      <SaveFormView {...sample} saved inList pending={pending} error={failed ? t('saves', 'status.unsaveFailed') : undefined} />
    </span>
  );
}

function RowMenu({ saved = false, pending, said }: { saved?: boolean; pending?: boolean; said?: boolean }) {
  const { t, locale } = useTranslate();
  return (
    <span className="pb-post__actions">
      <FeedRowActions
        labels={{ more: t('feeds', 'row.more', { title: sample.title }), list: t('feeds', 'row.list'), copy: t('feeds', 'row.copy') }}
        publishedAt="2026-11-03T23:30:00.000Z"
        locale={locale}
        onCopy={() => undefined}
        status={said ? t('saves', saved ? 'status.saved' : 'status.saveFailed') : ''}
        save={{ label: t('saves', saved ? 'action.unsave' : 'action.save'), onSave: () => undefined, pending }}
      />
    </span>
  );
}

/** The same row before the page has hydrated, or without scripts: the trigger's place is a one-button Save form. */
function RowForm({ saved = false }: { saved?: boolean }) {
  const { t, locale } = useTranslate();
  return (
    <span className="pb-post__actions">
      <FeedRowActions
        labels={{ more: t('feeds', 'row.more', { title: sample.title }), list: t('feeds', 'row.list'), copy: t('feeds', 'row.copy') }}
        publishedAt="2026-11-03T23:30:00.000Z"
        locale={locale}
        onCopy={() => undefined}
        status=""
        disabled
        save={{
          label: t('saves', saved ? 'action.unsave' : 'action.save'),
          onSave: () => undefined,
          form: {
            action: '/saved',
            fields: { intent: saved ? 'unsave' : 'save', postId: sample.postId, back: '/kit/feed-row-save-form' },
            label: t('saves', saved ? 'action.unsaveOn' : 'action.saveOn', { title: sample.title }),
          },
        }}
      />
    </span>
  );
}

function Empty() {
  const { t } = useTranslate();
  return (
    <EmptyState title={t('saves', 'empty.title')} action={<Link href="/all">{t('saves', 'empty.all')}</Link>}>
      {t('saves', 'empty.body')}
    </EmptyState>
  );
}

function Pages({ later }: { later?: boolean }) {
  const { t } = useTranslate();
  return (
    <Pager
      aria-label={t('saves', 'pages.label')}
      first={later ? { href: '/saved', label: t('saves', 'first') } : undefined}
      next={{ href: '/saved?cursor=sample', label: t('saves', 'next') }}
    />
  );
}

export const savesPieces: Readonly<Record<string, Composition>> = {
  'post-save': {
    name: 'Post page, Save and Unsave',
    states: {
      rest: () => <PostSave />,
      selected: () => <PostSave saved />,
      pending: () => <PostSave pending />,
      invalid: () => <PostSave failed />,
    },
  },
  'saved-unsave': {
    name: 'Saved row, Unsave',
    states: { rest: () => <RowUnsave />, pending: () => <RowUnsave pending />, invalid: () => <RowUnsave failed /> },
  },
  'feed-row-save': {
    name: 'Feed row menu with Save',
    states: {
      rest: () => <RowMenu />,
      selected: () => <RowMenu saved said />,
      pending: () => <RowMenu pending />,
      invalid: () => <RowMenu said />,
    },
  },
  'feed-row-save-form': {
    name: 'Feed row Save before hydration',
    states: { rest: () => <RowForm />, selected: () => <RowForm saved /> },
  },
  'saved-empty': { name: 'Saved, nothing saved', states: { rest: Empty } },
  'saved-pages': { name: 'Saved, page links', states: { rest: () => <Pages />, selected: () => <Pages later /> } },
};
