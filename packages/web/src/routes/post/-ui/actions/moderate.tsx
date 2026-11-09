import type { ContentActionProps } from '../../../-actions/props.ts';
import { ContentModerate } from '../../../modlog/-ui/content-moderate.tsx';

/** Remove or restore, and ban the author from the community (lane MODF). */
export function PostModerate(props: ContentActionProps) {
  return <ContentModerate kind="post" {...props} />;
}
