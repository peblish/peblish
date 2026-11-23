import { type } from 'arktype';
import type { MessageKey } from '../../../i18n/translate.ts';
import { savedPath } from '../../../shell/paths.ts';

// The enhanced Save and Unsave controls post the same form as without scripts (POST /saved,
// -post.ts), by fetch and asking for JSON.

export type SaveIntent = 'save' | 'unsave';
export type SaveOutcome = { ok: true; saved: boolean } | { ok: false; reason: string };

const Answer = type({ 'saved?': 'boolean', 'error?': 'string' });

export async function requestSave(intent: SaveIntent, postId: string): Promise<SaveOutcome> {
  try {
    const response = await fetch(savedPath, {
      method: 'POST',
      body: new URLSearchParams({ intent, postId }),
      headers: { accept: 'application/json' },
    });
    const answer = Answer(await response.json());
    if (answer instanceof type.errors) return { ok: false, reason: 'generic' };
    return typeof answer.saved === 'boolean' ? { ok: true, saved: answer.saved } : { ok: false, reason: answer.error ?? 'generic' };
  } catch {
    return { ok: false, reason: 'network' };
  }
}

/** What a failed save or unsave says: the post is gone, the visitor must sign in, or try again. */
export function failureKey(intent: SaveIntent, reason: string): MessageKey<'saves'> {
  if (reason === 'target.not_found') return 'status.gone';
  if (reason === 'auth.required') return 'status.signIn';
  return intent === 'save' ? 'status.saveFailed' : 'status.unsaveFailed';
}
