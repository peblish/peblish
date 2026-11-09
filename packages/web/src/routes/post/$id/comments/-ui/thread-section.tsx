import { threadDisplayDepth } from '@peblish/core/comments/limits';
import { parseSort, threadSorts } from '@peblish/core/comments/sort';
import { CommentThread } from '@peblish/ui/components/comment-thread';
import { ReplyBar } from '@peblish/ui/components/reply-bar';
import type { CommentView } from '@peblish/schema/views';
import { useRouter, useRouterState } from '@tanstack/react-router';
import { type } from 'arktype';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslate } from '../../../../../i18n/use-translate.ts';
import { useCommentThreadLabels, useReplyBarLabels } from '../../../../../shell/labels.ts';
import { commentPath, postPath, userPath } from '../../../../../shell/paths.ts';
import { castVoteFn } from '../../../-vote.ts';
import { loadThreadFn } from '../-thread-fn.ts';
import type { ThreadData } from '../-thread.ts';
import commentsCss from './comments.css?url';
import { asCommentError, errorKey, type CommentError } from './errors.ts';

// The thread under a post, and the whole of a permalink page: the sort choice, the comment
// tree (lane UI's CommentThread), and the docked reply bar. It draws the data it was given. A
// sort other than the one the page was loaded with is fetched once the page has hydrated; before
// that (and without JavaScript) the sort choice is a plain GET form, and the server renders the
// sort the document asks for. A reply is a plain form post too, to /post/<id>/comments.

const Answer = type({ 'ok?': 'boolean', 'error?': 'string' });
const Search = type({ 'sort?': 'unknown', 'commentError?': 'unknown' });

/** Plain text for the reply bar from a comment's rendered HTML; only displayed, and React escapes it. */
function excerptOf(html: string | null): string {
  const text = (html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39);/g, (_match, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[name] ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

export function ThreadSection({ data: loaded }: { data: ThreadData }) {
  const { t, locale } = useTranslate();
  const router = useRouter();
  const raw = useRouterState({ select: (state) => state.location.search });
  const search = Search(raw);
  const wanted = parseSort(search instanceof type.errors ? undefined : search.sort);
  const urlError = asCommentError(search instanceof type.errors ? undefined : search.commentError);

  // The sort the page was loaded with is the data; any other is fetched, and shown until then in the old order.
  const [fetched, setFetched] = useState<ThreadData | null>(null);
  useEffect(() => {
    if (loaded.sort === wanted) return;
    let current = true;
    loadThreadFn({ data: { postId: loaded.postId, sort: wanted, ...(loaded.focus && { rootId: loaded.focus.id }) } }).then(
      (next) => current && next && setFetched(next),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [loaded, wanted]);
  const data = loaded.sort === wanted ? loaded : (fetched ?? loaded);

  const labels = useCommentThreadLabels();
  const replyLabels = useReplyBarLabels();
  // The comment being answered: on a permalink page the one it starts from, else the post.
  const [targetId, setTargetId] = useState<string | null>(loaded.focus?.id ?? null);
  const target = data.comments.find((comment) => comment.id === targetId) ?? null;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<CommentError>();

  async function reply(body: string) {
    setPending(true);
    setError(undefined);
    try {
      const form = new URLSearchParams({ intent: 'reply', parent: target?.id ?? '', body, ...(data.focus && { focus: data.focus.id }) });
      const response = await fetch(`/post/${data.postId}/comments`, {
        method: 'POST',
        body: form,
        headers: { accept: 'application/json' },
      });
      const answer = Answer(await response.json());
      if (answer instanceof type.errors) throw new Error('unreadable answer');
      if (!answer.ok) {
        setError(asCommentError(answer.error) ?? 'generic');
        throw new Error(answer.error);
      }
      setTargetId(loaded.focus?.id ?? null);
      await router.invalidate();
    } catch (failure) {
      // The reply bar keeps what was typed when this rejects.
      setError((current) => current ?? 'network');
      throw failure;
    } finally {
      setPending(false);
    }
  }

  function chooseSort(event: FormEvent<HTMLFormElement>) {
    const submitter = event.nativeEvent instanceof SubmitEvent ? event.nativeEvent.submitter : null;
    const sort = submitter instanceof HTMLButtonElement ? parseSort(submitter.value) : null;
    if (!sort) return;
    event.preventDefault();
    void router.navigate({ href: `${window.location.pathname}?sort=${sort}#comments` });
  }

  const startReply = (comment: CommentView) => {
    setTargetId(comment.id);
    document.querySelector<HTMLTextAreaElement>('.pb-reply textarea')?.focus();
  };

  return (
    <section id="comments" className="cm-thread" data-slot="thread" aria-labelledby="comments-heading">
      {/* Without precedence, React leaves the link where it is. A precedence link would hold this part of the page back until a script reveals it. */}
      <link rel="stylesheet" href={commentsCss} />
      <div className="cm-head">
        <h2 id="comments-heading">{t('comments', 'heading')}</h2>
        <form method="get" action="#comments" onSubmit={chooseSort}>
          <div className="pb-segmented" role="group" aria-label={t('comments', 'sort.group')}>
            {threadSorts.map((sort) => (
              <button key={sort} type="submit" name="sort" value={sort} aria-pressed={sort === wanted}>
                {t('comments', `sort.${sort}`)}
              </button>
            ))}
          </div>
        </form>
      </div>
      {data.comments.length === 0 ? (
        <p className="cm-empty">{t('comments', 'empty')}</p>
      ) : (
        <CommentThread
          comments={data.comments}
          postAuthorId={data.postAuthorId}
          continueHref={(comment) => commentPath(data.postId, comment.id)}
          authorHref={(comment) => userPath(comment.author)}
          labels={labels}
          locale={locale}
          maxDepth={threadDisplayDepth}
          voteDisabled={data.viewerId === null}
          onVote={async (comment, value) => {
            const result = await castVoteFn({ data: { target: { kind: 'comment', id: comment.id }, value } });
            // A refusal throws, which puts the arrows and the score back.
            if (!result.ok) throw new Error(result.reason);
          }}
          {...(data.reply === 'yes' && { onReply: startReply })}
        />
      )}
      {urlError && (
        <p className="cm-error" role="alert">
          {t('comments', errorKey(urlError))}
        </p>
      )}
      {data.truncated && <p className="cm-hint">{t('comments', 'truncated', { count: data.comments.length })}</p>}
      {data.removals.length > 0 && (
        <details className="cm-removed">
          <summary>{t('comments', 'removed.heading', { count: data.removals.length })}</summary>
          <ul>
            {data.removals.map((removal) => (
              <li key={removal.id}>
                <a href={commentPath(data.postId, removal.id)}>@{removal.handle}</a>: {removal.reason ?? t('comments', 'removed.noReason')}
              </li>
            ))}
          </ul>
        </details>
      )}
      {data.reply === 'yes' ? (
        <ReplyBar
          target={target && { handle: `@${target.author.handle}`, excerpt: excerptOf(target.contentHtml) }}
          labels={replyLabels}
          action={`/post/${data.postId}/comments`}
          fields={{ intent: 'reply', parent: target?.id ?? '', ...(data.focus && { focus: data.focus.id }) }}
          onSubmit={reply}
          onPostInstead={() => setTargetId(null)}
          onCancel={() => setTargetId(null)}
          pending={pending}
          {...(error && { error: t('comments', errorKey(error)) })}
        />
      ) : (
        <p className="cm-notice" role="status">
          {data.reply === 'sign-in' ? (
            <>
              {t('comments', 'reply.signIn')}{' '}
              <a
                href={`/auth/sign-in?redirect=${encodeURIComponent(data.focus ? commentPath(data.postId, data.focus.id) : postPath(data.postId))}`}
              >
                {t('comments', 'reply.signInLink')}
              </a>
            </>
          ) : (
            t('comments', `reply.${data.reply}`)
          )}
        </p>
      )}
    </section>
  );
}
