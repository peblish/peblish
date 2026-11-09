import { PostCard } from '@peblish/ui/components/post-card';
import { Prose } from '@peblish/ui/components/prose';
import { DensityControl } from '@peblish/ui/density/density-control';
import { profileSorts, profileTabs } from '@peblish/core/profiles/input';
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

function CommentRow({ entry, data, path }: { entry: Comment; data: ProfileData; path: string }) {
  const { t } = useTranslate();
  const { view, post, community } = entry;
  const time = data.times[view.id];
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
      <p className="prof-comment-meta">
        <span className="prof-score">{t('profiles', 'comment.score', { count: view.counts.upvotes - view.counts.downvotes })}</span>{' '}
        {t('profiles', 'comment.on')} <a href={postPath(post.id)}>{post.title}</a> {t('profiles', 'comment.in')}{' '}
        <a href={communityPath(community)}>!{community.handle}</a>
        {time && (
          <>
            {' · '}
            <time dateTime={view.publishedAt} title={time.title}>
              {time.age}
            </time>
          </>
        )}
      </p>
      {view.contentHtml && <Prose html={view.contentHtml} className="prof-comment-text" />}
      {/* A div: the slots hold forms and menus, which a <p> cannot contain (the parser would close it). */}
      <div className="prof-comment-actions">
        <a href={commentPath(post.id, view.id)}>{t('profiles', 'comment.reply')}</a>
        {slot && (
          <>
            <CommentReport {...slot} />
            <CommentBlock {...slot} />
            <CommentModerate {...slot} />
          </>
        )}
      </div>
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
      <nav className="prof-tabs" aria-label={t('profiles', 'tabs.label')}>
        {profileTabs.map((tab) => (
          <a key={tab} href={profileHref(path, { tab, sort: data.sort })} aria-current={tab === data.tab ? 'page' : undefined}>
            {t('profiles', `tab.${tab}`)}
            {countOf[tab] !== null && <span className="prof-tabcount"> {new Intl.NumberFormat(locale).format(countOf[tab])}</span>}
          </a>
        ))}
      </nav>
      <div className="prof-toolbar">
        <div className="feed-seg" role="group" aria-label={t('profiles', 'sort.label')}>
          {profileSorts.map((sort) => (
            <a key={sort} href={profileHref(path, { tab: data.tab, sort })} aria-current={sort === data.sort ? 'true' : undefined}>
              {t('profiles', `sort.${sort}`)}
            </a>
          ))}
        </div>
        <span className="feed-space" />
        <DensityControl value={prefs.density} onChange={(density) => setPrefs({ density })} labels={densityLabels} />
      </div>

      {data.entries.length === 0 ? (
        <p className="prof-empty">{t('profiles', `empty.${data.tab}`)}</p>
      ) : (
        <ul className="prof-list feed-list" aria-label={t('profiles', 'list.posts')}>
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
              <CommentRow key={entry.view.id} entry={entry} data={data} path={profileHref(path, here)} />
            ),
          )}
        </ul>
      )}

      {(data.next || data.after) && (
        <nav className="feed-pages" aria-label={t('profiles', 'pages.label')}>
          {data.after && <a href={profileHref(path, here)}>{t('profiles', 'pages.first')}</a>}
          {data.next && (
            <a href={profileHref(path, { ...here, after: data.next })} rel="next">
              {t('profiles', 'pages.next')}
            </a>
          )}
        </nav>
      )}
    </>
  );
}
