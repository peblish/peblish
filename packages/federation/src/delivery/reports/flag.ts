import { reportCategories, type ReportCategory } from '@peblish/core/reports/categories';
import type { JsonObject } from '../../mapping/json.ts';
import { toWire } from '../../mapping/document.ts';

// The outbound Flag in the Lemmy dialect (Lemmy 0.19.21 `Report::send`, PieFed's flags task):
// `{ @context, id, type: 'Flag', actor, to: [community], audience: community, object, summary }`,
// no `content`. The summary is the category's label, " - ", and the reporter's details, which is
// how PieFed reads it and what Lemmy shows as the reason. Mastodon's and Mbin's shapes are not
// sent yet (lane LAB confirms them).

/** What a peer's moderator reads for each category; the wire text, not the interface's. */
export const flagLabels: Record<ReportCategory, string> = {
  child_safety: 'Child safety',
  terror_violence: 'Terrorism or violence',
  intimate_image: 'Intimate image',
  copyright: 'Copyright',
  under_16: 'Under 16',
  threats_harassment: 'Threats or harassment',
  hate: 'Hate',
  spam: 'Spam',
  fraud_illegal: 'Fraud or illegal activity',
  sexual_content: 'Sexual content',
  other: 'Other',
};

export const isCategory = (value: string): value is ReportCategory => reportCategories.some((key) => key === value);

export type FlagInput = {
  /** The Flag's id (`reports.ap_id`). */
  id: string;
  reporterApId: string;
  communityApId: string;
  targetApId: string;
  category: ReportCategory;
  details: string | null;
};

/** The Flag document to send. */
export function flagDocument({ id, reporterApId, communityApId, targetApId, category, details }: FlagInput): JsonObject {
  const reason = details ? `${flagLabels[category]} - ${details}` : flagLabels[category];
  return toWire({
    kind: 'activity',
    activity: {
      type: 'Flag',
      id,
      actorApId: reporterApId,
      communityApId,
      raw: null,
      report: { apId: id, reporterApId, targetApId, communityApId, reason, raw: null },
    },
  });
}
