import type { ComponentType, ReactNode } from 'react';
import { CheckIcon, ChevronDown, type IconProps } from './icons.tsx';
import { Menu } from './menu.tsx';
import { Text } from './text.tsx';

/** One choice in a feed menu: its id, its name and, for the trigger and the list, its glyph. */
export interface MenuChoice<Id extends string> {
  id: Id;
  label: string;
  icon?: ComponentType<IconProps>;
}

export interface FeedMenuLabels {
  /** The list's name: "Sort", "View". */
  group: string;
  /** Read after the current choice, since Mux's Menu has no checked items yet: "current". */
  current: string;
  /** The trigger's name, with what is chosen: "Sort: Top, Week", "View: Classic". */
  trigger: string;
}

/**
 * A choice in the list: its glyph, its name and, when it is the one in force, a tick and "current"
 * as the item's description (hidden). The description's element is always there: React Aria looks
 * for it only when the item mounts. Mux gap: Menu has no checked or radio items yet (m-collections).
 */
function Choice({ choice, current, labels }: { choice: MenuChoice<string>; current: boolean; labels: FeedMenuLabels }) {
  const Icon = choice.icon;
  return (
    <span className="pb-feed-menu__choice">
      {Icon && <Icon className="pb-feed-menu__choice-icon" />}
      <Text className="pb-feed-menu__choice-label">{choice.label}</Text>
      <Text slot="description" className="pb-sr">
        {current ? labels.current : ''}
      </Text>
      {current && <CheckIcon className="pb-feed-menu__check" />}
    </span>
  );
}

/**
 * The trigger: the glyph of the choice in force, its name (the phone shows the glyph alone) and a
 * chevron. Mux gap: Menu.Trigger is an unstyled button with no Button variants, so feed-menus.css
 * draws it as a quiet control. Disabled until the page has hydrated: Mux's menus need scripts.
 */
function Trigger({
  icon: Icon,
  labels,
  disabled,
  iconOnly,
  children,
}: {
  icon?: ComponentType<IconProps> | undefined;
  labels: FeedMenuLabels;
  disabled?: boolean | undefined;
  iconOnly?: boolean | undefined;
  children?: ReactNode;
}) {
  return (
    <Menu.Trigger className="pb-feed-menu" data-icon-only={iconOnly || undefined} aria-label={labels.trigger} disabled={disabled}>
      {Icon && <Icon className="pb-feed-menu__icon" />}
      {!iconOnly && <span className="pb-feed-menu__label">{children}</span>}
      <ChevronDown className="pb-feed-menu__chevron" />
    </Menu.Trigger>
  );
}

export interface SortMenuProps<Sort extends string, Period extends string> {
  sorts: readonly MenuChoice<Sort>[];
  sort: Sort;
  /** The sort that takes a period (Top): its item opens the periods as a submenu. */
  periodSort: Sort;
  periods: readonly MenuChoice<Period>[];
  period: Period;
  labels: FeedMenuLabels & { periodGroup: string };
  /** A new sort, or the period sort with a period. */
  onChange: (sort: Sort, period?: Period) => void;
  disabled?: boolean;
}

/**
 * A feed's sort (Commons' header menu): Hot, New, Old, and Top with its periods in a submenu. The
 * trigger names the sort in force and, for Top, its period ("Top Week").
 */
export function SortMenu<Sort extends string, Period extends string>({
  sorts,
  sort,
  periodSort,
  periods,
  period,
  labels,
  onChange,
  disabled,
}: SortMenuProps<Sort, Period>) {
  const current = sorts.find((choice) => choice.id === sort);
  const currentPeriod = periods.find((choice) => choice.id === period);
  return (
    <Menu.Root>
      <Trigger icon={current?.icon} labels={labels} disabled={disabled}>
        {current?.label}
        {sort === periodSort && currentPeriod && <span className="pb-feed-menu__sub"> {currentPeriod.label}</span>}
      </Trigger>
      <Menu.Popup placement="bottom-end">
        <Menu.List aria-label={labels.group}>
          {sorts.map((choice) =>
            choice.id === periodSort ? (
              <Menu.Submenu key={choice.id}>
                <Menu.Item id={choice.id} textValue={choice.label}>
                  <Choice choice={choice} current={choice.id === sort} labels={labels} />
                </Menu.Item>
                <Menu.Popup>
                  <Menu.List aria-label={labels.periodGroup}>
                    {periods.map((option) => (
                      <Menu.Item
                        key={option.id}
                        id={`${choice.id}-${option.id}`}
                        textValue={option.label}
                        onAction={() => onChange(choice.id, option.id)}
                      >
                        <Choice choice={option} current={sort === periodSort && option.id === period} labels={labels} />
                      </Menu.Item>
                    ))}
                  </Menu.List>
                </Menu.Popup>
              </Menu.Submenu>
            ) : (
              <Menu.Item key={choice.id} id={choice.id} textValue={choice.label} onAction={() => onChange(choice.id)}>
                <Choice choice={choice} current={choice.id === sort} labels={labels} />
              </Menu.Item>
            ),
          )}
        </Menu.List>
      </Menu.Popup>
    </Menu.Root>
  );
}

export interface ViewMenuProps<View extends string> {
  views: readonly MenuChoice<View>[];
  view: View;
  labels: FeedMenuLabels;
  onChange: (view: View) => void;
  disabled?: boolean;
}

/** A feed's view (Card, Classic, Compact) as Commons' header menu: the trigger is the view's glyph alone. */
export function ViewMenu<View extends string>({ views, view, labels, onChange, disabled }: ViewMenuProps<View>) {
  const current = views.find((choice) => choice.id === view);
  return (
    <Menu.Root>
      <Trigger icon={current?.icon} labels={labels} disabled={disabled} iconOnly />
      <Menu.Popup placement="bottom-end">
        <Menu.List aria-label={labels.group}>
          {views.map((choice) => (
            <Menu.Item key={choice.id} id={choice.id} textValue={choice.label} onAction={() => onChange(choice.id)}>
              <Choice choice={choice} current={choice.id === view} labels={labels} />
            </Menu.Item>
          ))}
        </Menu.List>
      </Menu.Popup>
    </Menu.Root>
  );
}
