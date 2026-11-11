// A menu button: <Menu.Root><Menu.Trigger>..</Menu.Trigger><Menu.Popup><Menu.List>
// <Menu.Item id=".." onAction={..}>..</Menu.Item></Menu.List></Menu.Popup></Menu.Root>.
// The popup mounts when it opens, so its items are not in the page until then.
export { Menu, type MenuProps } from '@muxui/react';
export type {
  MenuItemProps,
  MenuListProps,
  MenuPopupProps,
  MenuRootProps,
  MenuSectionProps,
  MenuSubmenuProps,
  MenuTriggerProps,
} from '@muxui/react';
