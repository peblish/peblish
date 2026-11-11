import { addBlockAs, removeBlockAs, resolveBlockTarget, type BlockTarget } from '@peblish/core/blocks/actions';
import { type } from 'arktype';
import { forbidden, formSession, principalOf, readForm, safeRedirect, sameOrigin } from '../../../server/auth.ts';
import { publicOrigin } from '@peblish/core/config';
import { blocksHref, tabOfKind } from './-tabs.ts';

// POST /settings/blocks: the page's own forms and every block slot (a profile, a post, a
// comment, a community page). `add` takes a typed `handle` (the page) or a `target` id (a slot),
// `remove` a `target`. 303 back to `back` when a slot gave one, else to the right tab; the
// enhanced forms ask for JSON and get the same address in `redirect` or the code in `error`.

const Body = type({
  intent: "'add' | 'remove'",
  kind: "'person' | 'community' | 'instance'",
  'handle?': 'string <= 300',
  'target?': 'string.uuid',
  'back?': 'string <= 500',
});

const wantsJson = (request: Request) => request.headers.get('accept')?.includes('application/json') ?? false;

/** The refusals a person can meet here, as the codes blocks.json has messages for; the rest are 'generic'. */
const shown = new Set(['handle.invalid', 'handle.not_found', 'block.own_instance', 'block.limit', 'target.protected', 'form.invalid']);
const gone = new Set(['target.not_found', 'target.deleted', 'community.deleted', 'community.removed']);
export const blockErrorCode = (reason: string) => (shown.has(reason) ? reason : gone.has(reason) ? 'gone' : 'generic');

export async function handleBlocksPost(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return forbidden();
  const json = wantsJson(request);
  const answer = (location: string, error?: string) =>
    json
      ? Response.json(error ? { error } : { redirect: location }, { status: error ? 400 : 200 })
      : new Response(null, { status: 303, headers: { location } });
  const { session, reply } = await formSession(request);
  if (!session) return reply({ redirect: '/auth/sign-in?redirect=%2Fsettings%2Fblocks' });
  // A form's fixed fields come in its address (block-form.tsx); what was typed is in the body, which wins.
  const body = Body({ ...Object.fromEntries(new URL(request.url).searchParams), ...(await readForm(request)) });
  if (body instanceof type.errors) return answer(blocksHref('people', { error: 'form.invalid' }), 'form.invalid');
  const tab = tabOfKind[body.kind];
  const typed = body.handle?.trim() ?? '';
  const fail = (code: string) => answer(blocksHref(tab, { error: code, q: typed }), code);
  const principal = principalOf(session.view);
  const origin = publicOrigin() ?? new URL(request.url).origin;
  const back = body.back ? safeRedirect(body.back, origin) : null;

  let target: BlockTarget;
  if (body.target) {
    target = body.kind === 'instance' ? { kind: 'instance', instanceId: body.target } : { kind: body.kind, actorId: body.target };
  } else if (body.intent === 'add') {
    const resolved = await resolveBlockTarget(body.kind, typed);
    if (!resolved.ok) return fail(resolved.reason);
    target = resolved.target;
  } else return answer(blocksHref(tab, { error: 'form.invalid' }), 'form.invalid');

  const targetId = target.kind === 'instance' ? target.instanceId : target.actorId;
  const result = body.intent === 'add' ? await addBlockAs(principal, target) : await removeBlockAs(principal, target);
  if (!result.ok) return fail(blockErrorCode(result.reason));
  return reply({ redirect: back ?? blocksHref(tab, body.intent === 'add' ? { just: targetId } : {}) });
}
