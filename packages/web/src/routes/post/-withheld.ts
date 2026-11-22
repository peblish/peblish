import type { ActorRef } from '@peblish/schema/views';

// What a tombstone says of its author to a reader who does not moderate the community: nothing. Core's
// views carry the author on every post and comment, and a page sends its data with the HTML for
// hydration, so the loaders take the author out (-page-data.ts postForViewer, $id/comments/-thread.ts)
// rather than only leave it unrendered. No imports beyond types: the page reads isWithheld too.

/** The author in a tombstone's place: no id, name, handle or address. */
export const withheldAuthor: ActorRef = {
  id: '00000000-0000-0000-0000-000000000000',
  apId: '',
  kind: 'Person',
  name: '',
  displayName: null,
  local: true,
  handle: '',
};

/** Whether a loader withheld this author: the page then draws no byline and no action that names them. */
export const isWithheld = (author: Pick<ActorRef, 'id'>): boolean => author.id === withheldAuthor.id;
