// Wire constants of the Lemmy dialect, which peblish speaks to every peer (README.md).

/** The ActivityStreams public collection. Lemmy 0.19 requires this full IRI in `to` (Delete above all). */
export const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
/** The Public collection under any name peers send it by (the compact forms come from JSON-LD compaction). */
export const isPublic = (address: string) => address === PUBLIC || address === 'as:Public' || address === 'Public';

/** The @context of every top-level document peblish sends: Lemmy's, which defines its extension terms. */
export const LEMMY_CONTEXT = ['https://join-lemmy.org/context.json', 'https://www.w3.org/ns/activitystreams'];

/** The followers collection of an actor, for the cc of a community's Announce (Lemmy, PieFed, Mbin and peblish all use this path). */
export const followersOf = (actorApId: string) => `${actorApId}/followers`;
