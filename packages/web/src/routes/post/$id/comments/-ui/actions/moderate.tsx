import type { ContentActionProps } from '../../../../../-actions/props.ts';
import { ContentModerate } from '../../../../../modlog/-ui/content-moderate.tsx';

/** Remove or restore, and ban the author from the community (lane MODF). */
export function CommentModerate(props: ContentActionProps) {
  return <ContentModerate kind="comment" {...props} />;
}
