import { commentMaxLength } from '@peblish/core/comments/input';
import { threadDisplayDepth } from '@peblish/core/comments/limits';
import { parseSort, threadSorts } from '@peblish/core/comments/sort';
import { Button } from '@peblish/ui/components/button';
import { ButtonGroup } from '@peblish/ui/components/button-group';
import { CommentThread, type CommentTreeLabels } from '@peblish/ui/components/comment-thread';
import type { Vote } from '@peblish/ui/components/vote-control';
import { EmptyState } from '@peblish/ui/components/empty-state';
import { Handle, neutraliseBidi } from '@peblish/ui/components/handle';
import { LockIcon } from '@peblish/ui/components/icons';
import { Link } from '@peblish/ui/components/link';
import { LinkedDisclosure } from '@peblish/ui/components/linked-disclosure';
import { Notice } from '@peblish/ui/components/notice';
import { Pager } from '@peblish/ui/components/pager';
import { ReplyBar, ReplyNotice } from '@peblish/ui/components/reply-bar';
import { absoluteUrl } from '@peblish/ui/components/share-link.ts';
import { Text } from '@peblish/ui/components/text';
import type { CommentView } from '@peblish/schema/views';
import { useRouter, useRouterState } from '@tanstack/react-router';
import { type } from 'arktype';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { translatePlural } from '../../../../../i18n/translate.ts';
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
import { NewSince } from './new-since.tsx';

// The thread under a post, and the whole of a permalink page (Commons' Comments.tsx): the heading
// with the sort choice, the comment tree (CommentThread, with Copy link and Share in its menu), and
// the docked reply bar, or where it would be, why there is none. It draws the data it was given. A
// sort or a page (?after=) other than the one the page was loaded with is fetched once the page
// has hydrated; before that (and without JavaScript) the sort choice is a plain GET form, the
// pages are plain links, and the server renders the sort and page the document asks for. A
// reply is a plain form post too, to /post/<id>/comments. "Removed by moderators" is a
// LinkedDisclosure: without JavaScript it is a link to this page with ?removed=1, which the
// server renders open.

const Answer = type({ 'ok?': 'boolean', 'error?': 'string' });
const Search = type({ 'sort?': 'unknown', 'after?': 'unknown', 'commentError?': 'unknown', 'removed?': 'unknown' });

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

/** The tree's labels: the ui catalogue's, with the Commons tree's own words from this area's. */
export function useTreeLabels(): CommentTreeLabels {
  const { t, locale } = useTranslate();
  const fresh: CommentTreeLabels = {
    ...useCommentThreadLabels(),
    reply: t('comments', 'action.reply'),
    share: t('comments', 'share.share'),
    more: t('comments', 'action.more'),
    menu: t('comments', 'action.menu'),
    copyLink: t('comments', 'share.copy'),
    linkCopied: t('comments', 'share.copied'),
    copyFailed: t('comments', 'share.failed'),
    inReplyTo: t('comments', 'inReplyTo'),
    isNew: t('visits', 'marker'),
  };
  // The rows are memoised and the labels a fresh object each render, but they depend on the locale
  // alone, so one object per locale lets a row skip re-rendering when the section does.
  // oxlint-disable-next-line react/exhaustive-deps
  return useMemo(() => fresh, [locale]);
}

async function vote(comment: CommentView, value: Vote) {
  const result = await castVoteFn({ data: { target: { kind: 'comment', id: comment.id }, value } });
  // A refusal throws, which puts the arrows and the score back.
  if (!result.ok) throw new Error(result.reason);
}

/**
 * `heading` names the thread ("11 comments" on the post page); the permalink page keeps the catalogue's
 * "Comments".
 */
export function ThreadSection({ data: loaded, heading }: { data: ThreadData; heading?: string }) {
  const { t, locale } = useTranslate();
  const router = useRouter();
  const raw = useRouterState({ select: (state) => state.location.search });
  const search = Search(raw);
  const wanted = parseSort(search instanceof type.errors ? undefined : search.sort);
  const wantedAfter = search instanceof type.errors || typeof search.after !== 'string' ? null : search.after;
  const urlError = asCommentError(search instanceof type.errors ? undefined : search.commentError);
  // The router reads ?removed=1 as the number 1.
  const removedOpen = !(search instanceof type.errors) && (search.removed === 1 || search.removed === '1');

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
  // On the loaded view a fetch shows only while it is the fresher (a refresh); a reply's reload is newer still.
  const data = fetchedHere && (!current || Date.parse(fetchedHere.now) >= Date.parse(loaded.now)) ? fetchedHere : loaded;

  // NewSince's refresh when a tab comes forward: the page on screen (this sort and cursor) fetched again, true
  // once it is drawn. The view is read when the answer comes, so one the reader has left since is not drawn.
  const view = useRef({ wanted, wantedAfter });
  useLayoutEffect(() => {
    view.current = { wanted, wantedAfter };
  });
  const drawn = useRef<{ data: ThreadData; done: (shown: boolean) => void } | null>(null);
  useEffect(() => {
    if (drawn.current?.data !== data) return;
    drawn.current.done(true);
    drawn.current = null;
  }, [data]);
  useEffect(() => () => drawn.current?.done(false), []);
  const refresh = useCallback(async () => {
    const asked = view.current;
    const next = await loadThreadFn({
      data: {
        postId: loaded.postId,
        sort: asked.wanted,
        ...(asked.wantedAfter && { after: asked.wantedAfter }),
        ...(loaded.focus && { rootId: loaded.focus.id }),
      },
    }).catch(() => null);
    if (!next || view.current.wanted !== asked.wanted || view.current.wantedAfter !== asked.wantedAfter) return false;
    return new Promise<boolean>((done) => {
      drawn.current?.done(false);
      drawn.current = { data: next, done };
      setFetched(next);
    });
  }, [loaded.postId, loaded.focus]);
  const now = useMemo(() => new Date(data.now), [data.now]);
  // The address of a page of this thread: the post's or the permalink's, in this sort.
  const here = data.focus ? commentPath(data.postId, data.focus.id) : postPath(data.postId);
  const pageHref = (cursor: string | null) =>
    `${here}?${new URLSearchParams({ sort: data.sort, ...(cursor && { after: cursor }) })}#comments`;
  // This page with the removed comments listed open (for a browser without JavaScript).
  const removedHref = `${here}?${new URLSearchParams({ sort: data.sort, ...(data.after ? { after: data.after } : {}), removed: '1' })}#th-removed`;

  const labels = useTreeLabels();
  const replyLabels = useReplyBarLabels();
  // The comment being answered: on a permalink page the one it starts from, else the post. The reply goes to
  // the comment chosen when the editor opened, whatever the list shows meanwhile (a refresh, another sort or
  // page): it is never sent to the post instead, and a parent gone from the server is refused there.
  const [choice, setChoice] = useState<{ id: string; comment: CommentView | null } | null>(
    loaded.focus ? { id: loaded.focus.id, comment: null } : null,
  );
  const targetId = choice?.id ?? null;
  const target = data.comments.find((comment) => comment.id === targetId) ?? choice?.comment ?? null;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<CommentError>();
  // "Reply posted.", read out politely once a reply is in: the field stays focused, and the comment lands in the tree.
  const [posted, setPosted] = useState('');
  const postedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(postedTimer.current), []);

  async function reply(body: string) {
    setPending(true);
    setError(undefined);
    try {
      const form = new URLSearchParams({ intent: 'reply', parent: targetId ?? '', body, ...(data.focus && { focus: data.focus.id }) });
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
      setChoice(loaded.focus ? { id: loaded.focus.id, comment: null } : null);
      await router.invalidate();
      clearTimeout(postedTimer.current);
      setPosted(t('comments', 'reply.posted'));
      postedTimer.current = setTimeout(() => setPosted(''), 4000);
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
  // The action slots of one comment row; forms posted from them come back to this comment. A tombstone
  // shows nothing of its author, so it has them only for those who moderate here (who can restore it).
  const renderActions = useMemo(
    () =>
      actions &&
      ((comment: CommentView) => {
        if ((comment.removed || comment.deleted) && !actions.viewer.moderator && !actions.viewer.admin) return null;
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

  // A comment's own address, for Copy link and Share, built when one is pressed (the page's origin).
  const linkOf = useCallback((comment: CommentView) => absoluteUrl(commentPath(postId, comment.id)), [postId]);

  // Reply on a comment points the docked bar at it and puts the caret there without scrolling: the bar is
  // in view, and a stuck bar scrolled into view would carry the page to the thread's end, away from the
  // comment being answered. The thread calls its latest onReply, so this needs no stable identity.
  const startReply = (comment: CommentView) => {
    setChoice({ id: comment.id, comment });
    document.querySelector<HTMLTextAreaElement>('.pb-reply textarea')?.focus({ preventScroll: true });
  };

  return (
    <section id="comments" className="th-thread" data-slot="thread" aria-labelledby="comments-heading">
      {/* Without precedence, React leaves the link where it is. A precedence link would hold this part of the page back until a script reveals it. */}
      <link rel="stylesheet" href={commentsCss} />
      <div className="th-head">
        <Text as="h2" variant="title" size="sm" id="comments-heading" className="th-heading">
          {heading ?? t('comments', 'heading')}
        </Text>
        {!data.focus && (
          <NewSince postId={data.postId} viewerId={data.viewerId} newCount={data.newCount} comments={data.comments} refresh={refresh} />
        )}
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
                className="th-sort"
                aria-pressed={sort === wanted}
              >
                {t('comments', `sort.${sort}`)}
              </Button>
            ))}
          </ButtonGroup>
        </form>
      </div>
      {data.comments.length === 0 ? (
        <EmptyState level={3} title={t('comments', 'empty')} />
      ) : (
        <CommentThread
          comments={data.comments}
          postAuthorId={data.postAuthorId}
          continueHref={continueHref}
          now={now}
          authorHref={authorHref}
          labels={labels}
          locale={locale}
          maxDepth={threadDisplayDepth}
          voteDisabled={data.viewerId === null}
          onVote={vote}
          linkOf={linkOf}
          focusId={focusId}
          {...(data.reply === 'yes' && { onReply: startReply })}
          {...(renderActions && { renderActions })}
        />
      )}
      {urlError && (
        <Notice tone="danger" role="alert" className="th-error">
          {t('comments', errorKey(urlError))}
        </Notice>
      )}
      <Pager
        aria-label={t('comments', data.focus ? 'pager.replies' : 'pager.comments')}
        {...(data.after ? { first: { href: pageHref(null), label: t('comments', data.focus ? 'first.replies' : 'first.comments') } } : {})}
        {...(data.next ? { next: { href: pageHref(data.next), label: t('comments', data.focus ? 'more.replies' : 'more.comments') } } : {})}
      />
      {data.removals.length > 0 && (
        <LinkedDisclosure
          id="th-removed"
          className="th-removed"
          title={t('comments', 'removed.heading', { count: data.removals.length })}
          openHref={removedHref}
          defaultExpanded={removedOpen}
        >
          <ul className="th-removed__list">
            {data.removals.map((removal) => (
              <li key={removal.id}>
                <Text size="sm">
                  <Link href={commentPath(data.postId, removal.id)}>
                    <Handle prefix="@" handle={removal.handle} />
                  </Link>
                  : {removal.reason ?? t('comments', 'removed.noReason')}
                </Text>
              </li>
            ))}
          </ul>
        </LinkedDisclosure>
      )}
      {data.reply === 'yes' ? (
        <ReplyBar
          target={target && { handle: `@${neutraliseBidi(target.author.handle)}`, excerpt: excerptOf(target.contentHtml) }}
          labels={replyLabels}
          action={`/post/${data.postId}/comments`}
          fields={{ intent: 'reply', parent: targetId ?? '', ...(data.focus && { focus: data.focus.id }) }}
          onSubmit={reply}
          onPostInstead={() => setChoice(null)}
          onCancel={() => setChoice(null)}
          pending={pending}
          {...(error && { error: t('comments', errorKey(error)) })}
          limit={{
            max: commentMaxLength,
            over: (count) =>
              translatePlural(locale, 'comments', 'reply.tooLong', count, { max: new Intl.NumberFormat(locale).format(commentMaxLength) }),
          }}
        />
      ) : (
        <ReplyNotice className="th-notice" icon={data.reply === 'locked' && <LockIcon />}>
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
        </ReplyNotice>
      )}
      {data.reply === 'yes' && (
        <Text role="status" className="pb-sr">
          {posted}
        </Text>
      )}
    </section>
  );
}
