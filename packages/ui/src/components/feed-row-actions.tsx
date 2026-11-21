import { CopyLinkIcon, EllipsisIcon } from './icons.tsx';
import { Menu } from './menu.tsx';
import { Text } from './text.tsx';

export interface FeedRowActionsLabels {
  /** The trigger's name, for one post: "More actions for <title>". */
  more: string;
  /** The list's name: "Post actions". */
  list: string;
  copy: string;
}

/**
 * The end of a feed row's action row (PostRow's `actions`): a menu of more actions, today Copy link
 * (Commons' post menu; Save, Hide and Report wait for their own branches), and a polite status that
 * says what Share or Copy link did ("Link copied"), beside the controls that did it. The status is
 * always in the page, so a change to it is read out. The trigger needs scripts: disabled until the page
 * has hydrated. Mux gap: Menu.Trigger has no Button look, so it takes the feed menus' quiet one.
 */
export function FeedRowActions({
  labels,
  onCopy,
  status,
  disabled,
}: {
  labels: FeedRowActionsLabels;
  onCopy: () => void;
  status: string;
  disabled?: boolean;
}) {
  return (
    <>
      <Menu.Root>
        <Menu.Trigger className="pb-feed-menu pb-post__action" data-icon-only aria-label={labels.more} disabled={disabled}>
          <EllipsisIcon />
        </Menu.Trigger>
        <Menu.Popup placement="bottom-end">
          <Menu.List aria-label={labels.list}>
            <Menu.Item id="copy" textValue={labels.copy} onAction={onCopy}>
              <span className="pb-feed-menu__choice">
                <CopyLinkIcon className="pb-feed-menu__choice-icon" />
                <Text className="pb-feed-menu__choice-label">{labels.copy}</Text>
              </span>
            </Menu.Item>
          </Menu.List>
        </Menu.Popup>
      </Menu.Root>
      <Text role="status" size="sm" color="muted" className="pb-feed-row-status">
        {status}
      </Text>
    </>
  );
}
