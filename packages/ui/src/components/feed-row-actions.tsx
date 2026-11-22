import { BookmarkIcon, CopyLinkIcon, EllipsisIcon } from './icons.tsx';
import { Menu } from './menu.tsx';
import { Text } from './text.tsx';
import { Time } from './time.tsx';

export interface FeedRowActionsLabels {
  /** The trigger's name, for one post: "More actions for <title>". */
  more: string;
  /** The list's name: "Post actions". */
  list: string;
  copy: string;
}

/** The menu's Save or Unsave (saves lane): its label for the post's state, and a save on its way disables it. */
export interface FeedRowSave {
  label: string;
  onSave: () => void;
  pending?: boolean;
}

/**
 * The end of a feed row's action row (PostRow's `actions`): a menu of more actions, Save or Unsave (when
 * `save` is given) and Copy link (Commons' post menu; Hide and Report wait for their own branches), and a polite status that
 * says what Share or Copy link did ("Link copied"), beside the controls that did it. The status is
 * always in the page, so a change to it is read out. The menu opens with the post's exact date and time
 * (`publishedAt`), which the row's age carries only in a title a pointer reaches: the menu is already one
 * stop per row, by keyboard and by touch, as a comment's is. The trigger needs scripts: disabled until the
 * page has hydrated. Mux gap: Menu.Trigger has no Button look, so it takes the feed menus' quiet one.
 */
export function FeedRowActions({
  labels,
  publishedAt,
  locale,
  onCopy,
  status,
  disabled,
  save,
}: {
  labels: FeedRowActionsLabels;
  publishedAt: string;
  locale: string;
  onCopy: () => void;
  status: string;
  disabled?: boolean;
  save?: FeedRowSave;
}) {
  return (
    <>
      <Menu.Root>
        <Menu.Trigger className="pb-feed-menu pb-post__action" data-icon-only aria-label={labels.more} disabled={disabled}>
          <EllipsisIcon />
        </Menu.Trigger>
        <Menu.Popup placement="bottom-end">
          <Menu.List aria-label={labels.list}>
            <Menu.Section title={<Time iso={publishedAt} locale={locale} format="date-time" />}>
              {save && (
                <Menu.Item id="save" textValue={save.label} onAction={save.onSave} disabled={save.pending}>
                  <span className="pb-feed-menu__choice">
                    <BookmarkIcon className="pb-feed-menu__choice-icon" />
                    <Text className="pb-feed-menu__choice-label">{save.label}</Text>
                  </span>
                </Menu.Item>
              )}
              <Menu.Item id="copy" textValue={labels.copy} onAction={onCopy}>
                <span className="pb-feed-menu__choice">
                  <CopyLinkIcon className="pb-feed-menu__choice-icon" />
                  <Text className="pb-feed-menu__choice-label">{labels.copy}</Text>
                </span>
              </Menu.Item>
            </Menu.Section>
          </Menu.List>
        </Menu.Popup>
      </Menu.Root>
      <Text role="status" size="sm" color="muted" className="pb-feed-row-status">
        {status}
      </Text>
    </>
  );
}
