import type { Principal } from '@peblish/schema/authz';
import { min } from 'drizzle-orm';
import { authorize } from '../authz/authorize.ts';
import { openGroup } from '../authz/actions/reports.ts';
import { contentState } from '../authz/state.ts';
import { db } from '../db/read.ts';
import { localInstance } from '../db/local-instance.ts';
import { reports } from '../db/tables/moderation.ts';
import { refusedAsResult, type Result } from '../identity/result.ts';
import { removeContent } from '../moderation/remove.ts';
import { readSetting } from '../settings/read.ts';
import type { ReportAudience, ReportCategory } from './categories.ts';
import { createReport } from './create.ts';
import { routeReports } from './route.ts';
import { resolveReports } from './resolve.ts';
import { removalStatement } from './statement.ts';
import type { ReportGroupKey, ReportTarget } from './types.ts';

// The report actions as web calls them: authorize, run the mutation, answer with a result (a
// refusal from the precheck or from inside the transaction alike).

export type NewReport = { target: ReportTarget; category: ReportCategory; forward: boolean; details: string };

export async function createReportAs(principal: Principal, input: NewReport) {
  const { details, ...subject } = input;
  const decision = await authorize('report.create', principal, subject);
  if (!decision.ok) return decision;
  return refusedAsResult(() => createReport(decision.grant, { details }));
}

/** Resolve or dismiss a whole group, with an optional note kept on its rows. */
export async function resolveReportsAs(
  principal: Principal,
  key: ReportGroupKey,
  input: { resolution: 'resolved' | 'dismissed'; note?: string | null },
): Promise<Result<{ count: number }>> {
  const decision = await authorize('report.resolve', principal, key);
  if (!decision.ok) return decision;
  return refusedAsResult(() => resolveReports(decision.grant, input));
}

/** Escalate to the admins, or (an admin) send an escalated group back to its moderators. */
export async function routeReportsAs(principal: Principal, key: ReportGroupKey, to: ReportAudience): Promise<Result<{ count: number }>> {
  const decision = await authorize('report.route', principal, { ...key, to });
  if (!decision.ok) return decision;
  return refusedAsResult(() => routeReports(decision.grant, {}));
}

/**
 * Removes the reported post or comment with a statement of reasons and resolves the group as
 * removed. Two transactions by design: the removal is the moderation mutation (its own modlog
 * row and event), and the resolution closes the group with that row's id. Content that is
 * already removed counts as done; admin-only reports keep their modlog row out of the public log.
 */
export async function removeFromReportAs(
  principal: Principal,
  key: ReportGroupKey,
  input: { rule: number; explanation: string },
): Promise<Result<{ count: number }>> {
  const resolve = await authorize('report.resolve', principal, key);
  if (!resolve.ok) return resolve;
  const { target, audience } = key;
  if (target.kind === 'actor') return { ok: false, reason: 'report.not_content' };
  const [oldest] = await db()
    .select({ number: min(reports.number) })
    .from(reports)
    .where(openGroup(target, audience));
  const state = await contentState({ db: db(), lock: false }, target);
  if (!oldest?.number || !state) return { ok: false, reason: 'report.not_open' };
  const [name, contactEmail, instance] = await Promise.all([readSetting('site.name'), readSetting('contact.email'), localInstance(db())]);
  const statement = removalStatement({
    caseNumber: oldest.number,
    decidedAt: new Date(),
    operator: { name: name || new URL(instance.origin).host, contactEmail },
    item: { kind: target.kind, apId: state.apId },
    rule: input.rule,
    explanation: input.explanation,
  });
  if (!statement.ok) return statement;
  const removal = await authorize('mod.remove', principal, { target });
  let modlogId: string | null = null;
  if (removal.ok) {
    const removed = await refusedAsResult(() =>
      removeContent(removal.grant, { reason: statement.text, public: audience === 'moderators' }),
    );
    if (removed.ok) modlogId = removed.modlogId;
    else if (removed.reason !== 'target.removed') return removed;
  } else if (removal.reason !== 'target.removed') {
    return removal;
  }
  return refusedAsResult(() => resolveReports(resolve.grant, { resolution: 'removed', note: input.explanation, modlogId }));
}
