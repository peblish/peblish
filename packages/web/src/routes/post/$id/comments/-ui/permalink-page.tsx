import { Breadcrumbs } from '@peblish/ui/components/breadcrumbs';
import { Button } from '@peblish/ui/components/button';
import { Disclosure } from '@peblish/ui/components/disclosure';
import { Group } from '@peblish/ui/components/group';
import { Link } from '@peblish/ui/components/link';
import { Text } from '@peblish/ui/components/text';
import { TextAreaField } from '@peblish/ui/components/text-area';
import { GateNotice } from '../../../../c/-ui/gate.tsx';
import { useTranslate } from '../../../../../i18n/use-translate.ts';
import { useRouteHydrated } from '../../../../../shell/hydration.ts';
import { commentPath, communityPath, postPath } from '../../../../../shell/paths.ts';
import type { loadPermalinkFn } from '../-thread-fn.ts';
import { ThreadSection } from './thread-section.tsx';

// /post/<id>/comments/<commentId>: "Continue this thread". One comment and what is under it,
// with the way back to the post and to the comment above, and, for the comment's author, the
// edit and delete forms (plain posts to /post/<id>/comments, as the reply bar's: the comment
// and the page go in the form's address, the intent on its submit button).

export type PermalinkData = NonNullable<Awaited<ReturnType<typeof loadPermalinkFn>>>;

export function PermalinkPage({
  data,
  postId,
  error,
}: {
  data: PermalinkData;
  postId: string;
  commentId: string;
  error?: string | undefined;
}) {
  const { t } = useTranslate();
  useRouteHydrated();
  if (data.kind === 'gate') return <GateNotice data={data} error={error} />;
  const { thread } = data;
  const formAction = (id: string) => `/post/${postId}/comments?${new URLSearchParams({ comment: id, focus: id })}`;
  return (
    <main className="post-page th-permalink">
      <Breadcrumbs
        aria-label={t('comments', 'permalink.trail')}
        className="th-trail"
        items={[
          { id: 'community', label: `!${data.communityHandle}`, href: communityPath({ handle: data.communityHandle }) },
          { id: 'post', label: data.postTitle, href: postPath(postId) },
          { id: 'comment', label: t('comments', 'permalink.crumb') },
        ]}
      />
      <Text as="h1" variant="heading" size="sm" className="th-title">
        {t('comments', 'permalink.title', { title: data.postTitle })}
      </Text>
      <Text as="p" color="muted" className="th-trail">
        {t('comments', 'permalink.single')} <Link href={`${postPath(postId)}#comments`}>{t('comments', 'permalink.all')}</Link>
        {thread.focus?.parentId && (
          <>
            {' · '}
            <Link href={commentPath(postId, thread.focus.parentId)}>{t('comments', 'permalink.parent')}</Link>
          </>
        )}
      </Text>
      {thread.own && (
        <Group className="th-own" aria-label={t('comments', 'own.group')}>
          <Disclosure className="th-own__edit" title={t('comments', 'own.edit')}>
            <form method="post" action={formAction(thread.own.id)}>
              <TextAreaField label={t('comments', 'own.editLabel')} name="body" rows={4} defaultValue={thread.own.bodyMd} required />
              <Button type="submit" name="intent" value="edit">
                {t('comments', 'own.save')}
              </Button>
            </form>
          </Disclosure>
          <form method="post" action={formAction(thread.own.id)}>
            <Button type="submit" name="intent" value="delete" variant="danger-neutral">
              {t('comments', 'own.delete')}
            </Button>
          </form>
        </Group>
      )}
      <ThreadSection data={thread} />
    </main>
  );
}
