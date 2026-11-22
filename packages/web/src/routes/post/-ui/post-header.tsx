import { Handle } from '@peblish/ui/components/handle';
import { Link } from '@peblish/ui/components/link';
import { Text } from '@peblish/ui/components/text';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { communityPath } from '../../../shell/paths.ts';
import { ViewHeader } from '../../../shell/view-header.tsx';

/**
 * The post page's and the comment pages' own view header (the routes say `viewHeader: 'own'`): Back, and
 * "Post in !community" as a link to the community, as the Commons thread has it. Every state of these
 * routes renders it (the post, a tombstone, the NSFW gate, which already names the community); a page
 * still loading or failed gets the frame's default bar.
 */
export function PostHeader({ handle }: { handle: string }) {
  const { t } = useTranslate();
  return (
    <ViewHeader
      title={
        <Link className="pb-link-quiet post-vh" href={communityPath({ handle })}>
          <Text variant="label" truncate className="post-vh__title">
            <Text variant="label" color="muted" className="post-vh__lead">
              {t('posts', 'header.postIn')}
            </Text>{' '}
            <Handle prefix="!" handle={handle} />
          </Text>
        </Link>
      }
    />
  );
}
