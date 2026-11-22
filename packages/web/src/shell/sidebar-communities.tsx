import type { ShellCommunity } from '@peblish/schema/views';
import { useHydrated } from '@peblish/ui/composer/use-hydrated.ts';
import { Avatar } from '@peblish/ui/components/avatar';
import { avatarInitial } from '@peblish/ui/components/avatar-initial.ts';
import { neutraliseBidi } from '@peblish/ui/components/handle';
import { EllipsisIcon } from '@peblish/ui/components/icons';
import { Menu } from '@peblish/ui/components/menu';
import { Sidebar } from '@peblish/ui/components/sidebar';
import { Text } from '@peblish/ui/components/text';
import { useId, useRef, useState, type ComponentType } from 'react';
import { useTranslate } from '../i18n/use-translate.ts';
import { communityPath } from './paths.ts';
import { pinErrorKey, usePinAction } from './pin-post.ts';

/** The Communities section's most rows while unpinned ones show; pinned ones always show in full (Commons). */
export const communityRows = 50;

/**
 * A community's name in the sidebar: its display name, else its name, without its directional controls; the
 * row isolates it (<bdi>), as display names from other servers are shown everywhere (BidiText).
 */
const communityLabel = (community: ShellCommunity) => neutraliseBidi(community.displayName?.trim() || community.name, '');

// A community's row draws a small Mux Avatar with its initial (the label's first character, whole:
// avatarInitial) as Sidebar.NavItem's icon (the shell's data has no community pictures yet), so folded into
// the rail the row keeps a mark and its tooltip. A pending follow rings it in dashes, since Mux hides a row's
// badge in the rail. One component per initial and state, so a row keeps its icon across renders.
const initialIcons = new Map<string, ComponentType<{ className?: string }>>();
export function initialIcon(label: string, pending = false): ComponentType<{ className?: string }> {
  const initial = avatarInitial(label, '');
  const key = `${pending ? 'p' : ''}${initial}`;
  let Icon = initialIcons.get(key);
  if (!Icon) {
    const ring = pending ? ' pb-nav__avatar--pending' : '';
    Icon = function CommunityInitial({ className }: { className?: string }) {
      return (
        <Avatar.Root size="sm" className={`${className ?? ''} pb-nav__avatar${ring}`} aria-hidden="true">
          <Avatar.Fallback>{initial}</Avatar.Fallback>
        </Avatar.Root>
      );
    };
    initialIcons.set(key, Icon);
  }
  return Icon;
}

/**
 * The rows of the sidebar's Communities section (Commons, notes/frame.md "Pinned communities"): the
 * viewer's pinned communities in their order, then a Sidebar.NavDivider when unpinned ones follow, then
 * the unpinned ones A to Z, up to `communityRows` rows in all (none once that many are pinned; the
 * directory and the finder reach the rest). A signed-out visitor's local communities are all listed, A to Z.
 * A pending follow says so in a badge and, folded, in its icon's ring.
 *
 * A pinned row's action is a menu (Move up, Move down, Unpin) that needs scripts: drawn from the server's
 * page on, so nothing moves when the page hydrates, disabled until then and hidden with scripts off
 * (shell/pins.css), where the directory's pinned group does the same with forms. After a move focus goes
 * back to the moved row's menu, after Unpin to its link, and a polite status says where it went.
 */
export function SidebarCommunities({
  local,
  remote,
  pathname,
  signedIn,
}: {
  local: readonly ShellCommunity[];
  remote: readonly ShellCommunity[];
  pathname: string;
  signedIn: boolean;
}) {
  const { t, locale } = useTranslate();
  const hydrated = useHydrated();
  const prefix = useId();
  const [status, setStatus] = useState('');
  const anchor = useRef<HTMLLIElement>(null);
  const action = usePinAction();
  const collator = new Intl.Collator(locale);
  const rows = [...local, ...remote].map((community) => ({ community, label: communityLabel(community) }));
  const pinned = rows
    .filter(({ community }) => community.pinned)
    .sort((a, b) => (a.community.pinPosition ?? 0) - (b.community.pinPosition ?? 0));
  const unpinned = rows
    .filter(({ community }) => !community.pinned)
    .sort((a, b) => collator.compare(a.label, b.label))
    .slice(0, signedIn ? Math.max(0, communityRows - pinned.length) : undefined);
  const triggerId = (id: string) => `${prefix}-pin-${id}`;

  // After the router has the new order: focus the row's menu, or its link once it is no longer pinned (the
  // row is drawn again without its menu, so wait for that, a few frames at most).
  const settle = (community: ShellCommunity, message: string, unpinnedNow: boolean) => () => {
    setStatus(message);
    const nav = anchor.current?.closest('nav');
    const focus = (frames: number) => {
      const menu = document.getElementById(triggerId(community.id));
      if (unpinnedNow && menu && frames > 0) return void requestAnimationFrame(() => focus(frames - 1));
      const link = nav?.querySelector<HTMLElement>(`a[href="${CSS.escape(communityPath(community))}"]`);
      (unpinnedNow ? link : menu)?.focus();
    };
    focus(30);
  };

  const row = ({ community, label }: (typeof rows)[number], place?: number) => {
    const href = communityPath(community);
    const pending = community.followState === 'pending';
    const menu =
      place === undefined ? undefined : (
        <Menu.Root>
          <Menu.Trigger
            id={triggerId(community.id)}
            className="pb-feed-menu pb-nav__pin-menu"
            data-icon-only
            aria-label={t('pins', 'pins.menu', { name: label })}
            disabled={!hydrated}
            aria-disabled={action.busy || undefined}
          >
            <EllipsisIcon />
          </Menu.Trigger>
          <Menu.Popup placement="bottom-end">
            <Menu.List aria-label={t('pins', 'pins.menuList')}>
              <Menu.Item
                id="up"
                disabled={place === 0}
                textValue={t('pins', 'pins.up')}
                onAction={() =>
                  action.run(
                    { community: community.id, intent: 'move', to: place - 1 },
                    settle(community, t('pins', 'pins.place', { name: label, place, total: pinned.length }), false),
                  )
                }
              >
                {t('pins', 'pins.up')}
              </Menu.Item>
              <Menu.Item
                id="down"
                disabled={place === pinned.length - 1}
                textValue={t('pins', 'pins.down')}
                onAction={() =>
                  action.run(
                    { community: community.id, intent: 'move', to: place + 1 },
                    settle(community, t('pins', 'pins.place', { name: label, place: place + 2, total: pinned.length }), false),
                  )
                }
              >
                {t('pins', 'pins.down')}
              </Menu.Item>
              <Menu.Item
                id="unpin"
                textValue={t('pins', 'pins.unpin')}
                onAction={() =>
                  action.run(
                    { community: community.id, intent: 'unpin' },
                    settle(community, t('pins', 'pins.unpinned', { name: label }), true),
                  )
                }
              >
                {t('pins', 'pins.unpin')}
              </Menu.Item>
            </Menu.List>
          </Menu.Popup>
        </Menu.Root>
      );
    return (
      <Sidebar.NavItem
        key={community.id}
        href={href}
        icon={initialIcon(label, pending)}
        current={pathname === href}
        badge={pending ? t('pins', 'pins.pending') : undefined}
        action={menu}
      >
        {/* An element with the text as its child, so Mux still reads the folded rail's tooltip from it. */}
        <bdi>{label}</bdi>
      </Sidebar.NavItem>
    );
  };

  return (
    <>
      {pinned.map((entry, place) => row(entry, place))}
      {pinned.length > 0 && unpinned.length > 0 && <Sidebar.NavDivider />}
      {unpinned.map((entry) => row(entry))}
      {/* Out of the flow, so it takes no room in the list; a change to it is read out once. A live region
          rather than role="status": the sidebar is on every page, and a page's own status stays the only one. */}
      <li className="pb-sr" ref={anchor}>
        <Text aria-live="polite" aria-atomic="true">
          {action.error ? t('pins', pinErrorKey(action.error)) : status}
        </Text>
      </li>
    </>
  );
}
