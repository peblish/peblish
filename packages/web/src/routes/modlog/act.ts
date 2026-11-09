import { banAs, removeAs, restoreAs, siteBanAs, siteUnbanAs, unbanAs } from '@peblish/core/bans/service';
import { createFileRoute } from '@tanstack/react-router';
import { type } from 'arktype';
import { forbidden, formSession, privateResponses, principalOf, readForm, safeRedirect, sameOrigin } from '../../server/auth.ts';
import { answer, Body, banEnd, needsReason, readReason, type Outcome } from './-act.ts';

// POST /modlog/act: every moderator form (the panels under a post, a comment or a profile, and the
// Bans tab) posts here with an `intent` and its target. The author is always told by the
// notification lane; there is no "notify" switch.
export const Route = createFileRoute('/modlog/act')({
  server: {
    middleware: [privateResponses],
    handlers: {
      POST: async ({ request }) => {
        if (!sameOrigin(request)) return forbidden();
        const { session } = await formSession(request);
        const cookies = session?.setCookies ?? [];
        const parsed = Body(await readForm(request));
        const origin = new URL(request.url).origin;
        const back = safeRedirect(parsed instanceof type.errors ? undefined : parsed.back, origin);
        if (parsed instanceof type.errors) return answer(request, cookies, { ok: false, reason: 'form.invalid' }, back, 'form');
        // Remove and restore share one panel key: after a stale click the page comes back showing the other one, and the message belongs there.
        const panel = parsed.id ? `content:${parsed.id}` : `${parsed.intent}:${parsed.person ?? ''}`;
        const respond = (outcome: Outcome) => answer(request, cookies, outcome, back, panel);
        if (!session) return respond({ ok: false, reason: 'auth.required' });
        const reason = readReason(parsed.reason);
        const expiresAt = banEnd(parsed);
        if (reason === undefined || ((parsed.intent === 'ban' || parsed.intent === 'site_ban') && expiresAt === undefined))
          return respond({ ok: false, reason: 'form.invalid' });
        if (needsReason(parsed.intent) && reason === null) return respond({ ok: false, reason: 'reason.required' });
        const input = { reason, public: parsed.public !== undefined };
        const principal = principalOf(session.view);
        const { id, kind, community, person } = parsed;
        const result = await (async () => {
          switch (parsed.intent) {
            case 'remove':
            case 'restore':
              if (!id || !kind) return null;
              return (parsed.intent === 'remove' ? removeAs : restoreAs)(principal, { kind, id }, input);
            case 'ban':
              if (!community || !person) return null;
              return banAs(
                principal,
                { communityId: community, targetActorId: person },
                { ...input, expiresAt: expiresAt ?? null, removeContent: parsed.removeContent !== undefined },
              );
            case 'unban':
              if (!community || !person) return null;
              return unbanAs(principal, { communityId: community, targetActorId: person }, input);
            case 'site_ban':
              if (!person) return null;
              return siteBanAs(principal, person, {
                ...input,
                expiresAt: expiresAt ?? null,
                removeContent: parsed.removeContent !== undefined,
              });
            case 'site_unban':
              if (!person) return null;
              return siteUnbanAs(principal, person, input);
          }
        })();
        if (result === null) return respond({ ok: false, reason: 'form.invalid' });
        return respond(result.ok ? { ok: true } : { ok: false, reason: result.reason });
      },
    },
  },
});
