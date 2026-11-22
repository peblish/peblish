import { asResolveError, type ResolveError } from '@peblish/core/resolve/outcome';
import { parseLookup } from '@peblish/core/resolve/parse';
import { CommunityFinder, type FinderLookup, type FinderRow } from '@peblish/ui/components/community-finder';
import { getRouteApi, useRouter } from '@tanstack/react-router';
import { type } from 'arktype';
import { useEffect, useMemo, useRef, useState } from 'react';
import { translatePlural } from '../../i18n/translate.ts';
import { useTranslate } from '../../i18n/use-translate.ts';
import { openInRouter } from '../client-links.ts';
import { communityPath, directoryPaths } from '../paths.ts';
import { finderGroups, matches, type FinderEntry } from './groups.ts';
import { findCommunities, type FoundCommunity } from './load.ts';

// The header's finder, loaded when it is first wanted (header.tsx): the popup, its data and the lookup. Typing
// asks the directory's reader (load.ts) after a pause, one request at a time: a newer text aborts the request
// for the older one, and an answer for any text but the current one is dropped. Typing writes nothing anywhere.

const root = getRouteApi('__root__');
const Answer = type({ 'redirect?': 'string', 'error?': 'string' });
/** How long the text rests before the directory is asked. */
const pauseMs = 200;

/** The host a lookup asks, as the resolve page names it. */
function askedHost(text: string): string | null {
  const lookup = parseLookup(text);
  if (!lookup) return null;
  return lookup.kind === 'handle' ? lookup.host : new URL(lookup.url).host;
}

/** `id` and `top` go to the popup (CommunityFinder). */
export default function Finder({ onClose, id, top }: { onClose: () => void; id: string; top?: number }) {
  const { t, locale } = useTranslate();
  const router = useRouter();
  const data = root.useLoaderData();
  const signedIn = data.session !== null;
  // The sidebar's own list (signed out it holds local communities nobody joined, so there is no Joined then).
  const joinedList = useMemo(() => (signedIn ? [...data.shell.local, ...data.shell.remote] : []), [signedIn, data.shell]);

  const [query, setQuery] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [answer, setAnswer] = useState<{ q: string; rows: FoundCommunity[] } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const q = query.trim();
  const lookupText = parseLookup(q) === null ? null : q;

  useEffect(() => {
    // A handle or an address lists nothing: the lookup row is the answer.
    if (lookupText !== null) return;
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        findCommunities({ data: { q }, signal: controller.signal }).then(
          ({ rows }) => {
            if (controller.signal.aborted) return;
            setAnswer({ q, rows });
            setFailed(null);
          },
          () => {
            if (!controller.signal.aborted) setFailed(q);
          },
        );
      },
      // The first answer at once; later ones once the typing rests.
      answer === null && q === '' ? 0 : pauseMs,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // `answer` only picks the first pause; a new answer is no reason to ask again.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [q, attempt, lookupText]);

  // The lookup: posted only when its row is chosen, never while typing (it is counted and may ask another server).
  const [asking, setAsking] = useState<string | null>(null);
  const [lookupError, setLookupError] = useState<{ text: string; code: ResolveError | 'network' } | null>(null);
  const lookupRequest = useRef<AbortController | null>(null);
  useEffect(() => () => lookupRequest.current?.abort(), []);

  async function lookUp() {
    if (lookupText === null) return;
    const text = lookupText;
    lookupRequest.current?.abort();
    const controller = new AbortController();
    lookupRequest.current = controller;
    setAsking(text);
    setLookupError(null);
    try {
      const response = await fetch(directoryPaths.find, {
        method: 'POST',
        body: new URLSearchParams({ q: text }),
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      const reply = Answer(await response.json());
      // The text changed while it was asked: this answer is for a lookup no longer shown.
      if (controller.signal.aborted) return;
      if (reply instanceof type.errors) return setLookupError({ text, code: 'generic' });
      if (reply.redirect) {
        onClose();
        return openInRouter(router, reply.redirect);
      }
      setLookupError({ text, code: asResolveError(reply.error) ?? 'generic' });
    } catch {
      if (!controller.signal.aborted) setLookupError({ text, code: 'network' });
    } finally {
      if (lookupRequest.current === controller) setAsking(null);
    }
  }

  const current = lookupText === null && answer?.q === q;
  // The rows shown while the next answer is on its way are the last answer's that still match.
  const found = lookupText === null ? (answer?.rows ?? []).filter((row) => matches(row.actor, q)) : [];
  // A pasted handle still finds a joined community by it ("!coffee@lantern.cafe").
  const groups = finderGroups({ joined: joinedList, found, query: q });
  const status = lookupText !== null || current ? 'ready' : failed === q ? 'error' : 'loading';

  const row = ({ actor, pending }: FinderEntry): FinderRow => ({
    id: actor.id,
    title: actor.displayName || actor.name,
    handle: actor.handle,
    href: communityPath(actor),
    note: pending ? t('finder', 'pending') : undefined,
  });

  let lookup: FinderLookup | null = null;
  if (lookupText !== null) {
    const host = askedHost(lookupText) ?? t('directory', 'resolve.pending.unknown');
    const error = lookupError?.text === lookupText ? lookupError.code : null;
    lookup = {
      title: t('finder', 'lookup.title', { text: lookupText }),
      description:
        asking === lookupText
          ? t('directory', 'resolve.pending', { host })
          : error
            ? t('directory', `resolve.error.${error}`)
            : signedIn
              ? t('finder', 'lookup.asks', { host })
              : t('finder', 'lookup.page'),
      pending: asking === lookupText,
      href: signedIn ? undefined : `${directoryPaths.find}?${new URLSearchParams({ q: lookupText })}`,
    };
  }

  const count = groups.joined.length + groups.others.length;
  const counted = count === 0 ? t('finder', 'count.none') : translatePlural(locale, 'finder', 'count', count);
  const announcement =
    status !== 'ready'
      ? ''
      : !lookup
        ? counted
        : count === 0
          ? t('finder', 'count.onlyLookup')
          : t('finder', 'count.lookup', { count: counted });

  return (
    <CommunityFinder
      id={id}
      top={top}
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      query={query}
      onQueryChange={(next) => {
        setQuery(next);
        // A lookup asked for other text is let go: its answer would take the person away from this one.
        if (next.trim() !== asking) lookupRequest.current?.abort();
      }}
      joined={groups.joined.map(row)}
      others={groups.others.map(row)}
      lookup={lookup}
      onLookup={() => void lookUp()}
      status={status}
      onRetry={() => {
        setFailed(null);
        setAttempt((n) => n + 1);
      }}
      announcement={announcement}
      labels={{
        field: t('shell', 'find'),
        placeholder: t('finder', 'placeholder'),
        clear: t('finder', 'clear'),
        results: t('finder', 'results'),
        joined: t('finder', 'joined'),
        others: t('finder', 'others'),
        lookup: t('finder', 'lookup'),
        loading: t('finder', 'loading'),
        error: t('finder', 'error'),
        retry: t('finder', 'retry'),
        noneTitle: t('finder', 'none.title'),
        noneBody: t('finder', 'none.body'),
      }}
    />
  );
}
