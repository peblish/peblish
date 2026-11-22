import type { ShellCommunity } from '@peblish/schema/views';
import { CommunityList, type CommunityListItem, type CommunityView } from '@peblish/ui/components/community-list';
import { BidiText, Handle } from '@peblish/ui/components/handle';
import { IconButton } from '@peblish/ui/components/icon-button';
import { ChevronDown, ChevronUpIcon, PinIcon } from '@peblish/ui/components/icons';
import { Notice } from '@peblish/ui/components/notice';
import { Text } from '@peblish/ui/components/text';
import { ToggleButton } from '@peblish/ui/components/toggle-button-group';
import { Tooltip } from '@peblish/ui/components/tooltip';
import { getRouteApi } from '@tanstack/react-router';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { communityPath } from '../../../shell/paths.ts';
import { pinErrorKey, usePinAction, type PinFields } from '../../../shell/pin-post.ts';

// The directory's pin controls (Commons, notes/community.md "Pin" and "The pinned group"): an
// icon-only Pin before Join on each row the viewer follows or asked to join, and above the list the
// viewer's pinned communities in their order with Move up and Move down. All are forms that post to
// /communities/pins and work without scripts (303 back to `next`); hydrated, they post by fetch,
// lock while pending, keep focus where it was and say what changed in a polite status. The sidebar's
// pinned group follows the same order. No drag: the chevrons are the way (see the lane's report).

const root = getRouteApi('__root__');

/** The viewer's pinned communities as the shell has them (the sidebar's order); none when signed out. */
export function useShellPins(): ShellCommunity[] {
  const shell = root.useLoaderData({ select: ({ shell }) => shell });
  return [...shell.local, ...shell.remote].filter((c) => c.pinned).sort((a, b) => (a.pinPosition ?? 0) - (b.pinPosition ?? 0));
}

const communityName = (community: { displayName: string | null; name: string }) => community.displayName?.trim() || community.name;

/** A form for one pin action; hydrated it posts by fetch and calls `done` once the data has reloaded. */
function PinActionForm({
  fields,
  next,
  run,
  done,
  children,
}: {
  fields: PinFields;
  next: string;
  run: (fields: PinFields, done?: () => void) => Promise<void>;
  done?: () => void;
  children: ReactNode;
}) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void run(fields, done);
  };
  return (
    <form method="post" action="/communities/pins" className="dir-pin__form" onSubmit={submit}>
      <input type="hidden" name="community" value={fields.community} />
      <input type="hidden" name="intent" value={fields.intent} />
      {fields.to !== undefined && <input type="hidden" name="to" value={fields.to} />}
      <input type="hidden" name="next" value={next} />
      {children}
    </form>
  );
}

/**
 * Pin as Mux's quiet ToggleButton: named "Pin" and the community, `aria-pressed` for whether it is on, an
 * outline glyph off and a filled one on, with Tooltip's hint. A submit button, for the form around it.
 */
export function PinButton({
  pinned,
  name,
  busy = false,
  id,
  describedBy,
}: {
  pinned: boolean;
  name: string;
  busy?: boolean;
  id?: string;
  describedBy?: string;
}) {
  const { t } = useTranslate();
  return (
    <Tooltip
      content={t('pins', 'pins.tooltip')}
      trigger={
        <ToggleButton
          id={id}
          type="submit"
          variant="quiet"
          size="sm"
          selected={pinned}
          className="dir-pin"
          data-pinned={pinned || undefined}
          aria-label={t('pins', 'pins.pin', { name })}
          aria-describedby={describedBy}
          aria-disabled={busy || undefined}
        >
          <PinIcon />
        </ToggleButton>
      }
    />
  );
}

/** Move up or Move down as a ghost IconButton, a submit button for the form around it. */
export function MoveButton({
  way,
  name,
  disabled = false,
  busy = false,
  id,
}: {
  way: 'up' | 'down';
  name: string;
  disabled?: boolean;
  busy?: boolean;
  id?: string;
}) {
  const { t } = useTranslate();
  return (
    <IconButton
      id={id}
      type="submit"
      variant="ghost"
      size="sm"
      className="dir-pin__move"
      disabled={disabled}
      pending={busy}
      aria-label={t('pins', way === 'up' ? 'pins.moveUp' : 'pins.moveDown', { name })}
    >
      {way === 'up' ? <ChevronUpIcon /> : <ChevronDown />}
    </IconButton>
  );
}

/** The id of a directory row's Pin, where focus goes when the pinned group's copy of the row goes away. */
export const rowPinId = (communityId: string) => `dir-pin-${communityId}`;

/**
 * Pin (PinButton) in a form of its own. It says what it did in a status of its own beside it, unless `onStatus` takes the words (the pinned
 * group, whose row goes away on Unpin), and then `onDone` says where focus goes.
 */
export function PinToggle({
  community,
  pinned,
  next,
  id,
  describedBy,
  onStatus,
  onDone,
}: {
  community: { id: string; displayName: string | null; name: string };
  pinned: boolean;
  next: string;
  id?: string;
  describedBy?: string;
  onStatus?: (message: string) => void;
  onDone?: () => void;
}) {
  const { t } = useTranslate();
  const action = usePinAction();
  const [status, setStatus] = useState('');
  const name = communityName(community);
  const done = () => {
    (onStatus ?? setStatus)(t('pins', pinned ? 'pins.unpinned' : 'pins.pinned', { name }));
    onDone?.();
  };
  return (
    <PinActionForm fields={{ community: community.id, intent: pinned ? 'unpin' : 'pin' }} next={next} run={action.run} done={done}>
      <PinButton pinned={pinned} name={name} busy={action.busy} id={id} describedBy={describedBy} />
      {!onStatus && (
        <Text role="status" className="pb-sr">
          {status}
        </Text>
      )}
      {action.error && (
        <Notice tone="danger" role="alert" className="dir-pin__error">
          {t('pins', pinErrorKey(action.error))}
        </Notice>
      )}
    </PinActionForm>
  );
}

/** Move up and Move down for one pinned row, each its own form; the ends are disabled. */
function MoveButtons({
  community,
  place,
  total,
  next,
  idFor,
  onStatus,
}: {
  community: ShellCommunity;
  place: number;
  total: number;
  next: string;
  idFor: (id: string, way: 'up' | 'down') => string;
  onStatus: (message: string) => void;
}) {
  const { t } = useTranslate();
  const action = usePinAction();
  const name = communityName(community);
  // After the reload the row has moved: focus the same button, or the other one once this end disables it.
  const done = (way: 'up' | 'down', to: number) => () => {
    const last = to === total - 1;
    const keep = way === 'up' ? to > 0 : !last;
    document.getElementById(idFor(community.id, keep ? way : way === 'up' ? 'down' : 'up'))?.focus();
    onStatus(t('pins', 'pins.place', { name, place: to + 1, total }));
  };
  const button = (way: 'up' | 'down') => {
    const to = way === 'up' ? place - 1 : place + 1;
    return (
      <PinActionForm fields={{ community: community.id, intent: 'move', to }} next={next} run={action.run} done={done(way, to)}>
        <MoveButton
          way={way}
          name={name}
          id={idFor(community.id, way)}
          disabled={way === 'up' ? place === 0 : place === total - 1}
          busy={action.busy}
        />
      </PinActionForm>
    );
  };
  return (
    <>
      {button('up')}
      {button('down')}
      {action.error && (
        <Notice tone="danger" role="alert" className="dir-pin__error">
          {t('pins', pinErrorKey(action.error))}
        </Notice>
      )}
    </>
  );
}

/**
 * The viewer's pinned communities above the directory, in their order (the sidebar's), in the view the
 * page shows: each with Move up, Move down and Pin. A polite status says where a row went.
 */
export function PinnedGroup({ pinned, view, next }: { pinned: readonly ShellCommunity[]; view: CommunityView; next: string }) {
  const { t } = useTranslate();
  const prefix = useId();
  const [status, setStatus] = useState('');
  const headingId = `${prefix}-title`;
  const idFor = (id: string, way: 'up' | 'down') => `${prefix}-${way}-${id}`;
  const items: CommunityListItem[] = pinned.map((community, place) => {
    const linkId = `${prefix}-link-${community.id}`;
    return {
      id: community.id,
      href: communityPath(community),
      linkId,
      title: <BidiText text={communityName(community)} />,
      initial: ([...communityName(community).trim()][0] ?? '?').toUpperCase(),
      meta: <Handle prefix="!" handle={community.handle} />,
      action: (
        <span className="dir-pin__actions">
          <MoveButtons community={community} place={place} total={pinned.length} next={next} idFor={idFor} onStatus={setStatus} />
          <PinToggle
            community={community}
            pinned
            next={next}
            describedBy={linkId}
            onStatus={setStatus}
            // The row leaves the group: focus its Pin in the list below, else the group's heading, else (the
            // group is gone with its last pin) the directory's search field.
            onDone={() =>
              (
                document.getElementById(rowPinId(community.id)) ??
                document.getElementById(headingId) ??
                document.querySelector<HTMLElement>('.dir-search input')
              )?.focus()
            }
          />
        </span>
      ),
    };
  });
  return (
    <section className="dir-pinned" aria-labelledby={headingId}>
      <Text as="h2" variant="label" size="sm" id={headingId} tabIndex={-1}>
        {t('pins', 'pins.group.title')}
      </Text>
      <CommunityList view={view} label={t('pins', 'pins.group.label')} items={items} />
      <Text role="status" className="pb-sr">
        {status}
      </Text>
    </section>
  );
}
