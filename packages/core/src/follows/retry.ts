// The first-contact retry rule (slice 3 open item b). Lemmy's outbound worker for an instance
// that has never seen our domain can skip what was queued before it started, so the first
// Follow to a new Lemmy instance may be lost; lemmy.world accepted a second one, sent about ten
// minutes later, in 34 seconds. An unanswered Follow is therefore sent again, under a fresh id,
// at these offsets from the first, and then left pending for good.

/** Resend an unanswered Follow this long after it was first sent: 5 minutes, and again at 15. */
export const followRetryOffsetsMs = [5 * 60_000, 15 * 60_000] as const;

/** The longest a Follow can still be due, with a margin, so the job only looks at recent rows. */
export const followRetryWindowMs = followRetryOffsetsMs[followRetryOffsetsMs.length - 1]! + 10 * 60_000;

/**
 * Whether a pending Follow is due for another send at `now`: some offset has passed since the
 * first send (createdAt) that the last send (sentAt) came before. After the 5-minute resend,
 * sentAt is past that offset, so only the 15-minute one is left; after it, none.
 */
export function retryDue(row: { createdAt: Date; sentAt: Date | null }, now: Date): boolean {
  const sent = (row.sentAt ?? row.createdAt).getTime();
  return followRetryOffsetsMs.some((offset) => {
    const at = row.createdAt.getTime() + offset;
    return at <= now.getTime() && sent < at;
  });
}
