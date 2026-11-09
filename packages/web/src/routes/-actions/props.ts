import type { ContentRef, Uuid } from '@peblish/schema/ids';
import type { ActorRef } from '@peblish/schema/views';

// The props of the action slots (decisions, "Shared slots"): `<surface>/-ui/actions/{report,
// moderate,block}.tsx` on the post page, the comment row, the profile and the community page.
// REP fills every report slot, MODF every moderate slot, E1 every block slot. A page renders the
// slots only for a signed-in viewer; each slot decides for itself whether it shows anything
// (nothing to report or block on one's own content, nothing to moderate without the role).
// Root owns this file: a lane that needs another prop asks for it.

/** The signed-in person looking at the page. `moderator` is for the community the slot is about (a profile: any community); `admin` needs two-factor on. */
export type SlotViewer = { actorId: Uuid; moderator: boolean; admin: boolean };

/** A post or a comment: the post page's and the comment row's slots. */
export type ContentActionProps = {
  target: ContentRef;
  author: ActorRef;
  community: ActorRef;
  removed: boolean;
  deleted: boolean;
  viewer: SlotViewer;
  /** Where a form posted from the slot sends the viewer back to (a path on this site). */
  back: string;
};

/** A person's profile (lane E1's page). `moderatedCommunities` are the viewer's communities where the person has live content (E1's readProfile). */
export type ProfileActionProps = {
  person: ActorRef;
  viewer: SlotViewer;
  moderatedCommunities: ActorRef[];
  back: string;
};

/** A community's page (lane COMM's). */
export type CommunityActionProps = {
  community: ActorRef;
  viewer: SlotViewer;
  back: string;
};
