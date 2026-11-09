import { useEffect, useRef, type RefObject } from 'react';

const openMenus = (root: HTMLElement | null) => root?.querySelectorAll<HTMLDetailsElement>('details.pb-menu[open]') ?? [];

/**
 * Closes the open <details> menus inside `root` on Escape, on a press outside them, and when
 * `key` changes after the first render (a navigation). The menus are plain <details>, so they
 * work before the page hydrates; this only adds the dismissal a disclosure lacks. A menu the
 * viewer opened before hydration finished stays open: the first render closes nothing.
 */
export function useMenuDismiss(root: RefObject<HTMLElement | null>, key: string): void {
  const lastKey = useRef(key);
  useEffect(() => {
    if (lastKey.current === key) return;
    lastKey.current = key;
    for (const menu of openMenus(root.current)) menu.open = false;
  }, [root, key]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      for (const menu of openMenus(root.current)) {
        menu.open = false;
        menu.querySelector('summary')?.focus();
      }
    }
    function onPress(event: PointerEvent) {
      for (const menu of openMenus(root.current)) if (event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPress);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPress);
    };
  }, [root]);
}
