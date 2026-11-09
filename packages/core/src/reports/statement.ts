// Lane REP. The statement of reasons (DSA Art 17) for a removal that came from a report. It
// fills the fields of tns/dsa/statement-of-reasons-template.md. Pure, and it takes nothing
// about the reporters: Art 17 does not require disclosing them and the template says not to.

/** The seven community rules (tns/policies/community-rules.md), cited by number in a removal. */
export const communityRules = [
  'Be at least 16 to have an account. Do not share or sell invitations or evade a restriction.',
  'Do not post child sexual abuse material, sexualised minors, grooming or exploitation.',
  'Do not share intimate images without consent, including synthetic images, or threaten to share them.',
  'No pornography, fetish content, graphic self-harm, encouragement of suicide or self-harm, or gratuitous graphic violence.',
  'No threats, terrorist promotion, targeted harassment, hate directed at protected groups, doxxing or coercive behaviour.',
  'No scams, malware, spam, illegal transactions or deliberate copyright infringement.',
  "Respect community topics and other people's privacy. Mark permitted sensitive material.",
] as const;

export const explanationLimit = 2000;

export type StatementInput = {
  /** The case number of the oldest report in the group, shown as "#N". */
  caseNumber: number;
  decidedAt: Date;
  /** The instance name and the published contact address (empty until the operator sets one). */
  operator: { name: string; contactEmail: string };
  /** The removed item. */
  item: { kind: 'post' | 'comment'; apId: string };
  /** Which community rule (1 to 7) the content broke. */
  rule: number;
  /** Facts and the link from the facts to the rule, in the moderator's words. */
  explanation: string;
};

export type Statement = { ok: true; text: string } | { ok: false; reason: 'report.reason_required' };

const rulePattern = /^[1-7]$/;

/** The statement text for the modlog's reason, or `report.reason_required` when the explanation or the rule is missing. */
export function removalStatement(input: StatementInput): Statement {
  const explanation = input.explanation.trim();
  if (explanation === '' || explanation.length > explanationLimit || !rulePattern.test(String(input.rule))) {
    return { ok: false, reason: 'report.reason_required' };
  }
  const rule = communityRules[input.rule - 1];
  const review = input.operator.contactEmail
    ? `Reply to ${input.operator.contactEmail} with this case number and why you think the decision is wrong.`
    : 'Contact the administrators of this instance with this case number and why you think the decision is wrong.';
  const text = [
    `Case: #${input.caseNumber}. Decision: ${input.decidedAt.toISOString()}. Operator: ${input.operator.name}.`,
    `What changed: the ${input.item.kind} was removed and is no longer shown on this instance.`,
    `Affected item: ${input.item.apId}. Scope: this instance. Duration: until a moderator restores it.`,
    `Facts: ${explanation} We looked at it after a user report.`,
    `Basis: community rule ${input.rule}, "${rule}"`,
    'Automated tools: none. A person reviewed this decision.',
    `Review: ${review} We aim to decide within seven days.`,
  ].join('\n');
  return { ok: true, text };
}
