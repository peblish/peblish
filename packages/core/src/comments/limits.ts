// How much of a thread one page reads and sends. Pure, so the page can import the depth it draws.

/** Levels sent and drawn (the thread component's maxDepth). A permalink page shows this many below its comment too. */
export const threadDisplayDepth = 6;
/** Comments a thread page sends, as Lemmy's default page size. */
export const threadMaxComments = 300;
/** Rows read for one thread, however many are then shown. */
export const threadFetchLimit = 2_000;
