// How much of a thread one page reads and sends. Pure, so the page can import the depth it draws.

/** Levels sent and drawn (the thread component's maxDepth). A permalink page shows this many below its comment too. */
export const threadDisplayDepth = 6;
/** Comments a thread page sends at the most, as Lemmy's default page size. */
export const threadMaxComments = 300;
/** Siblings a page lists from the set it pages: the post's top-level comments, or the replies under a permalink's comment. */
export const threadPageSize = 25;
/** Replies listed under any other comment; the rest are on that comment's own page, which pages them in turn. */
export const threadReplyPreview = 5;
