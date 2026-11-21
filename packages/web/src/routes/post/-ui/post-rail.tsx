import type { PostView } from '@peblish/schema/views';
import { FactList } from '@peblish/ui/components/fact-list';
import { BidiText, Handle } from '@peblish/ui/components/handle';
import { Link } from '@peblish/ui/components/link';
import { RailPanel } from '@peblish/ui/components/rail-panel';
import { Text } from '@peblish/ui/components/text';
import { Time } from '@peblish/ui/components/time';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { communityPath, userPath } from '../../../shell/paths.ts';
import { Rail } from '../../../shell/rail.tsx';

/**
 * The post's right rail (Commons' Rail.tsx, PostPanels), from what the page already has: where it was
 * posted, then the thread's facts (comments, who started it, when). Left out until their data exists: the
 * community's description, subscribers and Join, the thread's participants, last activity, language and
 * Follow thread. Below 62rem the frame hides the rail; the page itself already says all of this (the view
 * header, the meta line, the comments' heading). A withheld post (deleted, or removed to a reader who does
 * not moderate) keeps only where it was posted.
 */
export function PostRail({ post, withheld }: { post: PostView; withheld: boolean }) {
  const { t, locale } = useTranslate();
  const { community } = post;
  return (
    <Rail label={t('posts', 'rail.label')}>
      <RailPanel title={t('posts', 'rail.postedIn')}>
        <Link className="pb-link-quiet post-rail__community" href={communityPath(community)}>
          {community.displayName && (
            <Text variant="label" size="sm" className="post-rail__name">
              <BidiText text={community.displayName} />
            </Text>
          )}
          <Text size="sm" color="muted">
            <Handle prefix="!" handle={community.handle} />
          </Text>
        </Link>
      </RailPanel>
      {!withheld && (
        <RailPanel title={t('posts', 'rail.thread')}>
          <FactList
            size="xs"
            items={[
              { key: 'comments', label: t('posts', 'rail.comments'), value: new Intl.NumberFormat(locale).format(post.counts.comments) },
              {
                key: 'author',
                label: t('posts', 'rail.startedBy'),
                value: (
                  <Link href={userPath(post.author)}>
                    <Handle prefix="@" handle={post.author.handle} />
                  </Link>
                ),
              },
              {
                key: 'posted',
                label: t('posts', 'rail.posted'),
                value: <Time iso={post.publishedAt} locale={locale} format="date-time" />,
              },
            ]}
          />
        </RailPanel>
      )}
    </Rail>
  );
}
