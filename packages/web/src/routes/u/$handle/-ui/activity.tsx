import { Card } from '@peblish/ui/components/card';
import { EmptyState } from '@peblish/ui/components/empty-state';
import { Handle } from '@peblish/ui/components/handle';
import { Link } from '@peblish/ui/components/link';
import { LinkTabs } from '@peblish/ui/components/link-tabs';
import { Pager } from '@peblish/ui/components/pager';
import { PostCard } from '@peblish/ui/components/post-card';
import { Prose } from '@peblish/ui/components/prose';
import { Text } from '@peblish/ui/components/text';
import { Time } from '@peblish/ui/components/time';
import { DensityControl } from '@peblish/ui/density/density-control';
import { profileSorts, profileTabs } from '@peblish/core/profiles/input';
import type { ReactNode } from 'react';
import { useTranslate } from '../../../../i18n/use-translate.ts';
import { useDensityLabels, usePostCardLabels } from '../../../../shell/labels.ts';
import { communityPath, postPath, commentPath, userPath } from '../../../../shell/paths.ts';
import { usePrefs } from '../../../../shell/prefs.tsx';
import { castVoteFn } from '../../../post/-vote.ts';
import { CommentBlock } from '../../../post/$id/comments/-ui/actions/block.tsx';
import { CommentModerate } from '../../../post/$id/comments/-ui/actions/moderate.tsx';
import { CommentReport } from '../../../post/$id/comments/-ui/actions/report.tsx';
import type { ContentActionProps, SlotViewer } from '../../../-actions/props.ts';
import type { ProfileData, ProfileEntry } from '../-load.ts';
import { profileHref } from '../-search.ts';

type Comment = Extract<ProfileEntry, { kind: 'comment' }>;

/** A comment sits in an outlined Mux Card at the Card density, like the posts beside it, and in a plain row otherwise. */
function Surface({ card, children }: { card: boolean; children: ReactNode }) {
  return card ? (
    <Card.Root variant="outlined" padding="sm" className="prof-comment-body">
      {children}
    </Card.Root>
  ) : (
    <div className="prof-comment-body">{children}</div>
  );
}

function CommentRow({ entry, data, path, card }: { entry: Comment; data: ProfileData; path: string; card: boolean }) {
  const { t, locale } = useTranslate();
  const { view, post, community } = entry;
  const slotViewer: SlotViewer | null = data.viewer && {
    actorId: data.viewer.actorId,
    moderator: data.moderatedCommunities.some((moderated) => moderated.id === community.id),
    admin: data.viewer.admin,
  };
  const slot: ContentActionProps | null = slotViewer && {
    target: { kind: 'comment', id: view.id },
    author: data.person,
    community,
    removed: false,
    deleted: false,
    viewer: slotViewer,
    back: `${path}#comment-${view.id}`,
  };
  return (
    <li className="prof-comment" id={`comment-${view.id}`}>
      <Surface card={card}>
        <Text as="p" size="sm" color="muted" className="prof-comment-meta">
          <Text variant="label" size="sm" color="default">
            {t('profiles', 'comment.score', { count: view.counts.upvotes - view.counts.downvotes })}
          </Text>{' '}
          {t('profiles', 'comment.on')} <Link href={postPath(post.id)}>{post.title}</Link> {t('profiles', 'comment.in')}{' '}
          <Link href={communityPath(community)}>
            <Handle prefix="!" handle={community.handle} />
          </Link>
          {' · '}
          {/* Against the loader's clock, so the server and the browser print the same age. */}
          <Time iso={view.publishedAt} locale={locale} now={new Date(data.now)} />
        </Text>
        {view.contentHtml && <Prose html={view.contentHtml} className="prof-comment-text" />}
        {/* A div: the slots hold forms and menus, which a <p> cannot contain (the parser would close it). */}
        <div className="prof-comment-actions">
          <Link href={commentPath(post.id, view.id)}>{t('profiles', 'comment.reply')}</Link>
          {slot && (
            <>
              <CommentReport {...slot} />
              <CommentBlock {...slot} />
              <CommentModerate {...slot} />
            </>
          )}
        </div>
      </Surface>
    </li>
  );
}

/** The tabs, the sort and density controls, the list and its page links (profile-side.html). */
export function Activity({ data, path }: { data: ProfileData; path: string }) {
  const { t, locale } = useTranslate();
  const { prefs, setPrefs } = usePrefs();
  const densityLabels = useDensityLabels();
  const postLabels = usePostCardLabels();
  const here = { tab: data.tab, sort: data.sort };
  const countOf = { overview: null, posts: data.counts.posts, comments: data.counts.comments } as const;
  return (
    <>
      <LinkTabs
        aria-label={t('profiles', 'tabs.label')}
        items={profileTabs.map((tab) => {
          const count = countOf[tab];
          return {
            to: profileHref(path, { tab, sort: data.sort }),
            active: tab === data.tab,
            label: (
              <>
                {t('profiles', `tab.${tab}`)}
                {count !== null && <Text color="muted"> {new Intl.NumberFormat(locale).format(count)}</Text>}
              </>
            ),
          };
        })}
      />
      <div className="prof-toolbar">
        <LinkTabs
          aria-label={t('profiles', 'sort.label')}
          variant="segment"
          size="sm"
          items={profileSorts.map((sort) => ({
            to: profileHref(path, { tab: data.tab, sort }),
            active: sort === data.sort,
            label: t('profiles', `sort.${sort}`),
          }))}
        />
        <DensityControl value={prefs.density} onChange={(density) => setPrefs({ density })} labels={densityLabels} />
      </div>

      {data.entries.length === 0 ? (
        <EmptyState title={t('profiles', `empty.${data.tab}`)} />
      ) : (
        <ul className="prof-list" data-density={prefs.density} aria-label={t('profiles', 'list.posts')}>
          {data.entries.map((entry) =>
            entry.kind === 'post' ? (
              <li key={entry.item.post.id}>
                <PostCard
                  post={entry.item.post}
                  density={prefs.density}
                  hrefs={{
                    post: postPath(entry.item.post.id),
                    community: communityPath(entry.item.post.community),
                    author: userPath(entry.item.post.author),
                  }}
                  labels={postLabels}
                  locale={locale}
                  onVote={async (value) => {
                    const result = await castVoteFn({ data: { target: { kind: 'post', id: entry.item.post.id }, value } });
                    if (!result.ok) throw new Error(result.reason);
                  }}
                  voteDisabled={!data.viewer || entry.item.post.deleted}
                  now={new Date(data.now)}
                  thumbnailSrc={entry.item.thumbnailSrc}
                />
              </li>
            ) : (
              <CommentRow key={entry.view.id} entry={entry} data={data} path={profileHref(path, here)} card={prefs.density === 'card'} />
            ),
          )}
        </ul>
      )}

      <Pager
        aria-label={t('profiles', 'pages.label')}
        first={data.after ? { href: profileHref(path, here), label: t('profiles', 'pages.first') } : undefined}
        next={data.next ? { href: profileHref(path, { ...here, after: data.next }), label: t('profiles', 'pages.next') } : undefined}
      />
    </>
  );
}
