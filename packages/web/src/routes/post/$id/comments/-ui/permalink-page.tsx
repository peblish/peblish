import { Button } from '@peblish/ui/components/button';
import { TextAreaField } from '@peblish/ui/components/text-area';
import { GateNotice } from '../../../../c/-ui/gate.tsx';
import { useTranslate } from '../../../../../i18n/use-translate.ts';
import { useRouteHydrated } from '../../../../../shell/hydration.ts';
import { commentPath, communityPath, postPath } from '../../../../../shell/paths.ts';
import type { loadPermalinkFn } from '../-thread-fn.ts';
import { ThreadSection } from './thread-section.tsx';

// /post/<id>/comments/<commentId>: "Continue this thread". One comment and what is under it,
// with the way back to the post and to the comment above, and, for the comment's author, the
// edit and delete forms (plain posts to /post/<id>/comments, as the reply bar's).

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
  return (
    <main className="post-page cm-permalink">
      <h1 className="cm-title">{t('comments', 'permalink.title', { title: data.postTitle })}</h1>
      <p className="cm-trail">
        <a href={postPath(postId)}>{data.postTitle}</a> ·{' '}
        <a href={communityPath({ handle: data.communityHandle })}>!{data.communityHandle}</a>
      </p>
      <p className="cm-trail">
        {t('comments', 'permalink.single')} <a href={`${postPath(postId)}#comments`}>{t('comments', 'permalink.all')}</a>
        {thread.focus?.parentId && (
          <>
            {' · '}
            <a href={commentPath(postId, thread.focus.parentId)}>{t('comments', 'permalink.parent')}</a>
          </>
        )}
      </p>
      {thread.own && (
        <div className="cm-own" role="group" aria-label={t('comments', 'own.group')}>
          <details>
            <summary>{t('comments', 'own.edit')}</summary>
            <form method="post" action={`/post/${postId}/comments`}>
              <input type="hidden" name="intent" value="edit" />
              <input type="hidden" name="comment" value={thread.own.id} />
              <input type="hidden" name="focus" value={thread.own.id} />
              <TextAreaField label={t('comments', 'own.editLabel')} name="body" rows={4} defaultValue={thread.own.bodyMd} required />
              <Button type="submit">{t('comments', 'own.save')}</Button>
            </form>
          </details>
          <form method="post" action={`/post/${postId}/comments`}>
            <input type="hidden" name="intent" value="delete" />
            <input type="hidden" name="comment" value={thread.own.id} />
            <input type="hidden" name="focus" value={thread.own.id} />
            <Button type="submit">{t('comments', 'own.delete')}</Button>
          </form>
        </div>
      )}
      <ThreadSection data={thread} />
    </main>
  );
}
