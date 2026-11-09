import type { LineView } from '../-load.ts';
import { catalogues } from '../../../registry/i18n.gen.ts';
import type { MessageKey } from '../../../i18n/translate.ts';

// Which message names a modlog row's action. Most actions have one of their own; a few depend on
// whether the target is a post or a comment; an action a later lane adds (settings.*, page.*)
// falls back to its family's label, and anything else to "Action".

const known = new Set(Object.keys(catalogues.modlog.en));
const has = (key: string): key is MessageKey<'modlog'> => known.has(key);

export function actionKey(action: string, target: LineView['target']): MessageKey<'modlog'> {
  const byKind = target?.kind ? `action.${action}.${target.kind}` : null;
  if (byKind && has(byKind)) return byKind;
  const exact = `action.${action}`;
  if (has(exact)) return exact;
  const family = `action.${action.split('.')[0]}`;
  return has(family) ? family : 'action.other';
}

/** A ban's length from its row: permanent, whole days, or an end date when it is under a day. */
export function banLength(line: LineView): { kind: 'permanent' } | { kind: 'days'; count: number } | { kind: 'until'; at: string } | null {
  const { entry } = line;
  if (!['mod.ban', 'mod.site_ban'].includes(entry.action)) return null;
  const end = entry.details.expiresAt;
  if (!end) return { kind: 'permanent' };
  const days = Math.round((Date.parse(end) - Date.parse(entry.createdAt)) / 86_400_000);
  return days >= 1 ? { kind: 'days', count: days } : { kind: 'until', at: end };
}
