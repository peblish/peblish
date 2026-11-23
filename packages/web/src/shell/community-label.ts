import type { ActorRef } from '@peblish/schema/views';
import { neutraliseBidi } from '@peblish/ui/components/handle';

/**
 * A community's name in the sidebar: its display name, else its name, without its directional controls; the
 * row isolates it (<bdi>), as display names from other servers are shown everywhere (BidiText). The shell's
 * data takes the row's initial from it on the server (data.ts).
 */
export const communityLabel = (community: ActorRef) => neutraliseBidi(community.displayName?.trim() || community.name, '');
