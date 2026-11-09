import { BlockAction } from '../../../settings/blocks/-ui/block-action.tsx';
import type { CommunityActionProps } from '../../../-actions/props.ts';

/** Block the community. The community page (COMM) renders it for a signed-in viewer and shows its own notice for a community already blocked. */
export function CommunityBlock({ community, back }: CommunityActionProps) {
  return <BlockAction kind="community" target={community.id} back={back} look="button" />;
}
