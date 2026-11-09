import type { CommunityActionProps } from '../../../-actions/props.ts';
import { CommunityModerateTools } from '../../../modlog/-ui/content-moderate.tsx';

/** The community page's Mod tools (lane MODF). */
export function CommunityModerate(props: CommunityActionProps) {
  return <CommunityModerateTools {...props} />;
}
