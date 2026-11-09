import { useEffect, type RefObject } from 'react';

/**
 * Closes the open <details> menus inside `root` on Escape, on a press outside them, and when
 * `key` changes (a navigation). The menus are plain <details>, so they work before the page
 * hydrates; this only adds the dismissal a disclosure lacks.
 */
export function useMenuDismiss(root: RefObject<HTMLElement | null>, key: string): void {
  useEffect(() => {
    const open = () => root.current?.querySelectorAll<HTMLDetailsElement>('details.pb-menu[open]') ?? [];
    for (const menu of open()) menu.open = false;

    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      for (const menu of open()) {
        if (menu.open) {
          menu.open = false;
          menu.querySelector('summary')?.focus();
        }
      }
    }
    function onPress(event: PointerEvent) {
      for (const menu of open()) if (event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPress);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPress);
    };
  }, [root, key]);
}
