import { type } from 'arktype';

// Lane REP. The closed set of report categories and who sees each one. It follows
// tns/policies/illegal-content.md and tns/dsa/notice-and-action-spec.md. Pure: no database.

export const reportCategories = [
  'child_safety',
  'terror_violence',
  'intimate_image',
  'copyright',
  'under_16',
  'threats_harassment',
  'hate',
  'spam',
  'fraud_illegal',
  'sexual_content',
  'other',
] as const;
export type ReportCategory = (typeof reportCategories)[number];
export const ReportCategory = type.enumerated(...reportCategories);

/** What a report is about: content (a post or comment) or a person or community (an actor). */
export type ReportTargetKind = 'post' | 'comment' | 'actor';

export type ReportAudience = 'moderators' | 'admins';

type Spec = {
  /** Whether the category applies to content, to a person or community, or both. */
  content: boolean;
  person: boolean;
  /** Admin-only categories never reach community moderators and never federate. */
  audience: ReportAudience;
  /** A report in this category about content may also be sent to the moderators of a remote community. */
  federates: boolean;
};

const specs: Record<ReportCategory, Spec> = {
  child_safety: { content: true, person: true, audience: 'admins', federates: false },
  terror_violence: { content: true, person: true, audience: 'admins', federates: false },
  intimate_image: { content: true, person: false, audience: 'admins', federates: false },
  copyright: { content: true, person: false, audience: 'admins', federates: false },
  under_16: { content: false, person: true, audience: 'admins', federates: false },
  threats_harassment: { content: true, person: true, audience: 'moderators', federates: true },
  hate: { content: true, person: true, audience: 'moderators', federates: true },
  spam: { content: true, person: true, audience: 'moderators', federates: true },
  fraud_illegal: { content: true, person: true, audience: 'moderators', federates: true },
  sexual_content: { content: true, person: false, audience: 'moderators', federates: true },
  other: { content: true, person: true, audience: 'moderators', federates: true },
};

/** The categories a reporter may pick for a target, in display order. */
export function categoriesFor(kind: ReportTargetKind): ReportCategory[] {
  return reportCategories.filter((category) => (kind === 'actor' ? specs[category].person : specs[category].content));
}

/** Who sees a report: a person or community is always the admins', whatever the category. */
export function audienceOf(category: ReportCategory, kind: ReportTargetKind): ReportAudience {
  return kind === 'actor' ? 'admins' : specs[category].audience;
}

/** Whether the category may be sent to a remote community's moderators. */
export function mayFederate(category: ReportCategory, kind: ReportTargetKind): boolean {
  return kind !== 'actor' && specs[category].federates;
}

/** True when the category is for admins even on content. */
export const adminOnly = (category: ReportCategory): boolean => specs[category].audience === 'admins';
