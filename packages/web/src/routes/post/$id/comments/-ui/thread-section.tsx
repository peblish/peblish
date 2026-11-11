import { threadDisplayDepth } from '@peblish/core/comments/limits';
import { parseSort, threadSorts } from '@peblish/core/comments/sort';
import { Button } from '@peblish/ui/components/button';
import { ButtonGroup } from '@peblish/ui/components/button-group';
import { CommentThread } from '@peblish/ui/components/comment-thread';
import type { Vote } from '@peblish/ui/components/vote-control';
import { Disclosure } from '@peblish/ui/components/disclosure';
import { Link } from '@peblish/ui/components/link';
import { ReplyBar } from '@peblish/ui/components/reply-bar';
import { Text } from '@peblish/ui/components/text';
import type { CommentView } from '@peblish/schema/views';
import { useRouter, useRouterState } from '@tanstack/react-router';
import { type } from 'arktype';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslate } from '../../../../../i18n/use-translate.ts';
import { useCommentThreadLabels, useReplyBarLabels } from '../../../../../shell/labels.ts';
import { commentPath, postPath, userPath } from '../../../../../shell/paths.ts';
import { castVoteFn } from '../../../-vote.ts';
import { loadThreadFn } from '../-thread-fn.ts';
import { CommentBlock } from './actions/block.tsx';
import { CommentModerate } from './actions/moderate.tsx';
import { CommentReport } from './actions/report.tsx';
import type { ContentActionProps } from '../../../../-actions/props.ts';
import type { ThreadData } from '../-thread.ts';
import commentsCss from './comments.css?url';
import { asCommentError, errorKey, type CommentError } from './errors.ts';

// The thread under a post, and the whole of a permalink page: the sort choice, the comment
// tree (lane UI's CommentThread), and the docked reply bar. It draws the data it was given. A
// sort or a page (?after=) other than the one the page was loaded with is fetched once the page
// has hydrated; before that (and without JavaScript) the sort choice is a plain GET form, the
// pages are plain links, and the server renders the sort and page the document asks for. A
// reply is a plain form post too, to /post/<id>/comments.

const Answer = type({ 'ok?': 'boolean', 'error?': 'string' });
const Search = type({ 'sort?': 'unknown', 'after?': 'unknown', 'commentError?': 'unknown' });

/** Plain text for the reply bar from a comment's rendered HTML; only displayed, and React escapes it. */
function excerptOf(html: string | null): string {
  const text = (html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39);/g, (_match, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[name] ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

const authorHref = (comment: CommentView) => userPath(comment.author);

async function vote(comment: CommentView, value: Vote) {
  const result = await castVoteFn({ data: { target: { kind: 'comment', id: comment.id }, value } });
  // A refusal throws, which puts the arrows and the score back.
  if (!result.ok) throw new Error(result.reason);
}

export function ThreadSection({ data: loaded }: { data: ThreadData }) {
  const { t, locale } = useTranslate();
  const router = useRouter();
  const raw = useRouterState({ select: (state) => state.location.search });
  const search = Search(raw);
  const wanted = parseSort(search instanceof type.errors ? undefined : search.sort);
  const wantedAfter = search instanceof type.errors || typeof search.after !== 'string' ? null : search.after;
  const urlError = asCommentError(search instanceof type.errors ? undefined : search.commentError);

  // The sort and page the page was loaded with are the data; any other is fetched, and shown until then as before.
  // `loaded` is a dependency: a reply invalidates the router, and the fresh load must fetch the other view again.
  const [fetched, setFetched] = useState<ThreadData | null>(null);
  const current = loaded.sort === wanted && loaded.after === wantedAfter;
  useEffect(() => {
    if (current) return;
    let live = true;
    loadThreadFn({
      data: {
        postId: loaded.postId,
        sort: wanted,
        ...(wantedAfter && { after: wantedAfter }),
        ...(loaded.focus && { rootId: loaded.focus.id }),
      },
    }).then(
      (next) => live && next && setFetched(next),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [current, loaded, wanted, wantedAfter]);
  // A fetch is drawn only for the view it was made for, so one left from another view (back on the loaded one, or on a third) never shows.
  const fetchedHere = fetched?.sort === wanted && fetched.after === wantedAfter ? fetched : null;
  const data = current ? loaded : (fetchedHere ?? loaded);
  const times = useMemo(() => new Map(Object.entries(data.times)), [data.times]);
  // The address of a page of this thread: the post's or the permalink's, in this sort.
  const pageHref = (cursor: string | null) =>
    `${data.focus ? commentPath(data.postId, data.focus.id) : postPath(data.postId)}?${new URLSearchParams({ sort: data.sort, ...(cursor && { after: cursor }) })}#comments`;

  const freshLabels = useCommentThreadLabels();
  // The thread's rows are memoised, and the labels are a fresh object each render but depend on
  // the locale alone, so one object per locale lets a row skip re-rendering when this section does.
  // oxlint-disable-next-line react/exhaustive-deps
  const labels = useMemo(() => freshLabels, [locale]);
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

  // What the thread calls while it renders keeps its identity until the data changes, so the rows' memo holds.
  const { actions, postId } = data;
  const focusId = data.focus?.id ?? null;
  // The action slots of one comment row; forms posted from them come back to this comment.
  const renderActions = useMemo(
    () =>
      actions &&
      ((comment: CommentView) => {
        const props: ContentActionProps = {
          target: { kind: 'comment', id: comment.id },
          author: comment.author,
          community: actions.community,
          removed: comment.removed,
          deleted: comment.deleted,
          viewer: actions.viewer,
          back: `${focusId ? commentPath(postId, focusId) : postPath(postId)}#comment-${comment.id}`,
        };
        return (
          <>
            <CommentReport {...props} />
            <CommentBlock {...props} />
            <CommentModerate {...props} />
          </>
        );
      }),
    [actions, focusId, postId],
  );
  // The comment a permalink starts from pages its own replies, below.
  const continueHref = useCallback(
    (comment: CommentView) => (comment.id === focusId ? null : commentPath(postId, comment.id)),
    [focusId, postId],
  );

  const startReply = useCallback((comment: CommentView) => {
    setTargetId(comment.id);
    document.querySelector<HTMLTextAreaElement>('.pb-reply textarea')?.focus();
  }, []);

  return (
    <section id="comments" className="th-thread" data-slot="thread" aria-labelledby="comments-heading">
      {/* Without precedence, React leaves the link where it is. A precedence link would hold this part of the page back until a script reveals it. */}
      <link rel="stylesheet" href={commentsCss} />
      <div className="th-head">
        <Text as="h2" variant="title" size="sm" id="comments-heading">
          {t('comments', 'heading')}
        </Text>
        <form method="get" action="#comments" onSubmit={chooseSort}>
          <ButtonGroup role="group" aria-label={t('comments', 'sort.group')} attached>
            {threadSorts.map((sort) => (
              <Button
                key={sort}
                type="submit"
                name="sort"
                value={sort}
                size="sm"
                variant={sort === wanted ? 'primary' : 'neutral'}
                aria-pressed={sort === wanted}
              >
                {t('comments', `sort.${sort}`)}
              </Button>
            ))}
          </ButtonGroup>
        </form>
      </div>
      {data.after && (
        <Text as="p" className="th-more">
          <Link href={pageHref(null)}>{t('comments', data.focus ? 'first.replies' : 'first.comments')}</Link>
        </Text>
      )}
      {data.comments.length === 0 ? (
        <Text as="p" color="muted" className="th-empty">
          {t('comments', 'empty')}
        </Text>
      ) : (
        <CommentThread
          comments={data.comments}
          postAuthorId={data.postAuthorId}
          continueHref={continueHref}
          times={times}
          authorHref={authorHref}
          labels={labels}
          locale={locale}
          maxDepth={threadDisplayDepth}
          voteDisabled={data.viewerId === null}
          onVote={vote}
          {...(data.reply === 'yes' && { onReply: startReply })}
          {...(renderActions && { renderActions })}
        />
      )}
      {urlError && (
        <Text as="p" role="alert" className="th-error">
          {t('comments', errorKey(urlError))}
        </Text>
      )}
      {data.next && (
        <Text as="p" className="th-more">
          <Link href={pageHref(data.next)}>{t('comments', data.focus ? 'more.replies' : 'more.comments')}</Link>
        </Text>
      )}
      {data.removals.length > 0 && (
        <Disclosure className="th-removed" title={t('comments', 'removed.heading', { count: data.removals.length })}>
          <ul className="th-removed__list">
            {data.removals.map((removal) => (
              <li key={removal.id}>
                <Text size="sm">
                  <Link href={commentPath(data.postId, removal.id)}>@{removal.handle}</Link>:{' '}
                  {removal.reason ?? t('comments', 'removed.noReason')}
                </Text>
              </li>
            ))}
          </ul>
        </Disclosure>
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
        <Text as="p" color="muted" role="status" className="th-notice">
          {data.reply === 'sign-in' ? (
            <>
              {t('comments', 'reply.signIn')}{' '}
              <Link
                href={`/auth/sign-in?redirect=${encodeURIComponent(data.focus ? commentPath(data.postId, data.focus.id) : postPath(data.postId))}`}
              >
                {t('comments', 'reply.signInLink')}
              </Link>
            </>
          ) : (
            t('comments', `reply.${data.reply}`)
          )}
        </Text>
      )}
    </section>
  );
}
