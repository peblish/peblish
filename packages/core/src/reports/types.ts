import type { ContentRef, Uuid } from '@peblish/schema/ids';

/** What a report is about: a post or comment, or a person or community (an actor). */
export type ReportTarget = ContentRef | { kind: 'actor'; id: Uuid };

export type ReportGroupKey = { target: ReportTarget; audience: 'moderators' | 'admins' };
