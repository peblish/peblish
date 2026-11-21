import type { ReactNode } from 'react';
import { Avatar } from './avatar.tsx';
import { Card } from './card.tsx';
import { BulletListIcon, LayoutGridIcon } from './icons.tsx';
import { Link } from './link.tsx';
import { Text } from './text.tsx';
import { ToggleButton, ToggleButtonGroup } from './toggle-button-group.tsx';
import { SkelCircle, SkelLine, SkelPill, type Width } from '../skeleton/shape.tsx';

/** How the directory lists communities: rows (the default) or a grid of cards. */
export type CommunityView = 'list' | 'cards';
export const communityViews = ['list', 'cards'] as const satisfies readonly CommunityView[];
export const isCommunityView = (value: unknown): value is CommunityView => communityViews.some((view) => view === value);

export interface CommunityListItem {
  id: string;
  href: string;
  /** The community's name as people read it (its title, else its name). */
  title: ReactNode;
  /** The full handle, and what else fits on the line under the title (members). */
  meta: ReactNode;
  /** The letter an icon without a picture shows. */
  initial: string;
  /** Beside the title: NSFW and the like. */
  badges?: ReactNode;
  /** A line about the community: in a row under the meta, in a card clamped to three lines. */
  about?: ReactNode;
  /** Small print under it (where a copy comes from). */
  note?: ReactNode;
  /** The identity link's id, which the row's action names as its description. */
  linkId?: string;
  /** At the row's end, or a card's foot: Join. */
  action?: ReactNode;
}

/** One link for the community: its icon, its title, and the handle line. The whole block is the target. */
function Identity({ item }: { item: CommunityListItem }) {
  return (
    <Link href={item.href} id={item.linkId} className="pb-clist__link pb-link-quiet">
      <Avatar.Root size="md" className="pb-clist__icon" aria-hidden="true">
        <Avatar.Fallback>{item.initial}</Avatar.Fallback>
      </Avatar.Root>
      <span className="pb-clist__text">
        <Text variant="label" className="pb-clist__title">
          {item.title}
        </Text>
        <Text size="sm" color="muted" className="pb-clist__meta">
          {item.meta}
        </Text>
      </span>
    </Link>
  );
}

/**
 * The directory's communities (Commons, the mock's DirRow and DirCard): a list of rows, each the
 * community's identity link and its action at the end, or a grid of Mux Cards (outlined) holding the
 * same link, the community's line clamped to three lines and the action at the foot. Both are one
 * `ul` named by `label`; the Tab order is the reading order either way: each link, then its action.
 */
export function CommunityList({ view, label, items }: { view: CommunityView; label: string; items: readonly CommunityListItem[] }) {
  return (
    <ul className="pb-clist" data-view={view} aria-label={label}>
      {items.map((item) =>
        view === 'cards' ? (
          <li key={item.id} className="pb-clist__item">
            <Card.Root variant="outlined" padding="sm" className="pb-clist__card">
              <div className="pb-clist__head">
                <Identity item={item} />
                {item.badges && <span className="pb-clist__badges">{item.badges}</span>}
              </div>
              {item.about && (
                <Text as="p" size="sm" className="pb-clist__about">
                  {item.about}
                </Text>
              )}
              {item.note && (
                <Text as="p" size="xs" color="muted">
                  {item.note}
                </Text>
              )}
              {item.action && <div className="pb-clist__foot">{item.action}</div>}
            </Card.Root>
          </li>
        ) : (
          <li key={item.id} className="pb-clist__item pb-clist__row">
            <div className="pb-clist__main">
              <div className="pb-clist__head">
                <Identity item={item} />
                {item.badges && <span className="pb-clist__badges">{item.badges}</span>}
              </div>
              {item.about && (
                <Text as="p" size="sm" className="pb-clist__line">
                  {item.about}
                </Text>
              )}
              {item.note && (
                <Text as="p" size="xs" color="muted" className="pb-clist__line">
                  {item.note}
                </Text>
              )}
            </div>
            {item.action && <div className="pb-clist__end">{item.action}</div>}
          </li>
        ),
      )}
    </ul>
  );
}

export interface CommunityViewLabels {
  /** The group's name: "View". */
  group: string;
  list: string;
  cards: string;
}

/**
 * List or Cards: a Mux ToggleButtonGroup with single selection (a radio group named "View"), as the
 * feed's density switch is. It reports the choice; the page keeps it (a browser preference). On a
 * phone each choice is its glyph alone, a 44px square, its word kept as its name.
 */
export function CommunityViewControl({
  value,
  onChange,
  labels,
}: {
  value: CommunityView;
  onChange: (view: CommunityView) => void;
  labels: CommunityViewLabels;
}) {
  return (
    <ToggleButtonGroup
      className="pb-cview"
      aria-label={labels.group}
      size="sm"
      selectionMode="single"
      disallowEmptySelection
      selectedIds={[value]}
      onSelectionChange={([id]) => {
        if (isCommunityView(id)) onChange(id);
      }}
    >
      <ToggleButton id="list">
        <BulletListIcon />
        <span className="pb-cview__label">{labels.list}</span>
      </ToggleButton>
      <ToggleButton id="cards">
        <LayoutGridIcon />
        <span className="pb-cview__label">{labels.cards}</span>
      </ToggleButton>
    </ToggleButtonGroup>
  );
}

const titleWidths: readonly Width[] = [50, 40, 60, 30, 50, 40];

/**
 * The directory while it loads, in the view chosen: rows or cards in the list's own classes, so the
 * communities replace them in place. The shapes are hidden; `label` is the one status.
 */
export function CommunityListSkeleton({ view, label }: { view: CommunityView; label?: string }) {
  return (
    <div className="pb-skeleton" data-skeleton="">
      {label && (
        <Text role="status" className="pb-sr">
          {label}
        </Text>
      )}
      <ul aria-hidden="true" className="pb-skeleton__shapes pb-clist" data-view={view}>
        {titleWidths.map((width, index) => (
          <li key={index} className={view === 'cards' ? 'pb-clist__item' : 'pb-clist__item pb-clist__row'}>
            <div className={view === 'cards' ? 'pb-clist__card pb-clist__card--skeleton' : 'pb-clist__main'}>
              <div className="pb-clist__link">
                <SkelCircle />
                <span className="pb-clist__text">
                  <SkelLine kind="label" width={width} />
                  <SkelLine kind="meta" width={70} />
                </span>
              </div>
              {view === 'cards' && <SkelLine kind="meta" width={90} />}
              {view === 'cards' && <SkelPill size="sm" />}
            </div>
            {view === 'list' && <SkelPill size="sm" />}
          </li>
        ))}
      </ul>
    </div>
  );
}
