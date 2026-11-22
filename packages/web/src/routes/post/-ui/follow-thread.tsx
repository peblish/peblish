import { IconButton } from '@peblish/ui/components/icon-button';
import { BellIcon, BellRingIcon } from '@peblish/ui/components/icons';
import { Switch } from '@peblish/ui/components/switch';
import { Text } from '@peblish/ui/components/text';
import { useToast } from '@peblish/ui/components/toast';
import { useHydrated } from '@peblish/ui/composer/use-hydrated.ts';
import { useRouter } from '@tanstack/react-router';
import { type } from 'arktype';
import { useState, useSyncExternalStore, type FormEvent } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { watchAction } from '../../notifications/-search.ts';

// Follow thread on the post page (Commons' Thread.tsx FollowBell and Rail.tsx's switch; lane
// f-notify): the bell in the view header and the switch in the rail, one state for both. The bell is
// a plain form, so it follows and unfollows without scripts (the inbox's endpoint answers 303 back
// to the post); the switch needs them and reads only until the page hydrates. A change shows at once
// in both, goes back on a refusal (with a toast), and is said politely once it is saved.

/** The state a press asked for, by post, until the server answers: what the bell and the switch show meanwhile. */
const asked = new Map<string, boolean>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const setAsked = (postId: string, watching: boolean | undefined) => {
  if (watching === undefined) asked.delete(postId);
  else asked.set(postId, watching);
  for (const listener of listeners) listener();
};

const Answer = type({ ok: 'true', watching: 'boolean' }).or({ error: 'string' });

/** The post's follow state for both controls: what is shown, whether a change is on its way, and the change itself. */
function useFollowThread(postId: string, watching: boolean) {
  const { t } = useTranslate();
  const router = useRouter();
  const toast = useToast();
  const wanted = useSyncExternalStore(
    subscribe,
    () => asked.get(postId),
    () => undefined,
  );
  const [said, setSaid] = useState('');
  async function change(next: boolean) {
    if (asked.has(postId)) return;
    setAsked(postId, next);
    setSaid('');
    let answer: typeof Answer.infer | { error: string };
    try {
      const response = await fetch(watchAction(next ? 'watch' : 'unwatch', postId), {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: '',
      });
      const read = Answer(await response.json());
      answer = read instanceof type.errors ? { error: 'generic' } : read;
    } catch {
      answer = { error: 'network' };
    }
    if ('ok' in answer) {
      await router.invalidate();
      setSaid(t('watches', answer.watching ? 'status.on' : 'status.off'));
    } else toast.add(t('watches', 'error'), { variant: 'danger' });
    setAsked(postId, undefined);
  }
  return { on: wanted ?? watching, pending: wanted !== undefined, said, change };
}

/** What the bell and the switch draw: on or off, and whether a change is on its way. */
export type FollowView = { postId: string; on: boolean; pending: boolean };

/**
 * The bell in the post's view header: a toggle (aria-pressed) whose name stays "Follow thread", in a
 * form that posts without scripts. `said` is the polite status once a change is saved.
 */
export function FollowBellButton({
  postId,
  on,
  pending,
  said = '',
  onSubmit,
}: FollowView & { said?: string; onSubmit?: (event: FormEvent<HTMLFormElement>) => void }) {
  const { t } = useTranslate();
  return (
    <form method="post" action={watchAction(on ? 'unwatch' : 'watch', postId)} onSubmit={onSubmit} className="post-follow">
      <IconButton
        type="submit"
        variant="ghost"
        aria-label={t('watches', 'follow')}
        aria-pressed={on}
        pending={pending}
        data-state={on ? 'on' : 'off'}
      >
        {on ? <BellRingIcon aria-hidden="true" /> : <BellIcon aria-hidden="true" />}
      </IconButton>
      <Text as="span" role="status" className="pb-sr">
        {said}
      </Text>
    </form>
  );
}

/** The rail's switch: read-only while a change is on its way or until the page hydrates (`readOnly`). */
export function FollowSwitchControl({
  on,
  pending,
  readOnly = false,
  onChange,
}: FollowView & { readOnly?: boolean; onChange?: (next: boolean) => void }) {
  const { t } = useTranslate();
  return (
    <Switch
      size="sm"
      selected={on}
      readOnly={readOnly || pending}
      description={t('watches', 'follow.note')}
      onChange={onChange}
      className="post-rail__follow"
      label={t('watches', 'follow')}
    />
  );
}

/** The bell, live: a press changes the follow at once, by fetch once hydrated. */
export function FollowBell({ postId, watching }: { postId: string; watching: boolean }) {
  const follow = useFollowThread(postId, watching);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void follow.change(!follow.on);
  };
  return <FollowBellButton postId={postId} on={follow.on} pending={follow.pending} said={follow.said} onSubmit={submit} />;
}

/** The rail's switch, live: the same state as the bell; the bell is the control without scripts. */
export function FollowSwitch({ postId, watching }: { postId: string; watching: boolean }) {
  const hydrated = useHydrated();
  const follow = useFollowThread(postId, watching);
  return (
    <FollowSwitchControl
      postId={postId}
      on={follow.on}
      pending={follow.pending}
      readOnly={!hydrated}
      onChange={(next) => void follow.change(next)}
    />
  );
}
