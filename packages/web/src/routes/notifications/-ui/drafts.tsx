import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from 'react';
import type { CommentError } from '../../post/$id/comments/-ui/errors.ts';

// A notice's reply in place, kept by notice id for as long as the inbox is open (the inbox holds it, one per viewer;
// NoticeGroups holds its own only where nothing above it does, as on the gallery's pages). A notice whose age
// crosses into the next group, when a reload brings the loader's later clock, is drawn anew in that group's list,
// and a filter with nothing in it draws no rows at all, so state of its own row would start over: its field would
// close, its text go, and a reply on its way lose its lock, so it could be sent again. Kept here, they carry over,
// and so does focus in the reply's form, with the field's caret.

export type ReplyDraft = {
  open: boolean;
  text: string;
  /** A reply is on its way: from the press until the comment is saved and the notice marked read. */
  pending: boolean;
  error: CommentError | undefined;
  /** The new comment's id once it is posted ('' when the answer named none), until Reply is pressed again. */
  posted: string | null;
};

const fresh: ReplyDraft = { open: false, text: '', pending: false, error: undefined, posted: null };

type Change = Partial<ReplyDraft> | ((draft: ReplyDraft) => Partial<ReplyDraft>);

/** Which control of the reply's form had focus as its row left the page, and the field's selection if it was the field. */
type Focus = { at: number; selection: readonly [number, number] | null };

type Drafts = {
  drafts: ReadonlyMap<string, ReplyDraft>;
  change: (id: string, change: Change) => void;
  /** Takes the notice's lock at once, for a second submit that comes before React has drawn `pending`; false while it is held. */
  lock: (id: string) => boolean;
  unlock: (id: string) => void;
  /** Focus in a reply's form whose row has just left the page, for the row drawn anew in the same commit. */
  focus: Map<string, Focus>;
};

function useDrafts(): Drafts {
  const [drafts, setDrafts] = useState<ReadonlyMap<string, ReplyDraft>>(() => new Map());
  // Made once; setDrafts never changes, so neither do these.
  const [tools] = useState(() => {
    const locks = new Set<string>();
    const change = (id: string, next: Change) =>
      setDrafts((all) => {
        const draft = all.get(id) ?? fresh;
        return new Map(all).set(id, { ...draft, ...(typeof next === 'function' ? next(draft) : next) });
      });
    return {
      change,
      lock: (id: string) => {
        if (locks.has(id)) return false;
        locks.add(id);
        change(id, { pending: true });
        return true;
      },
      unlock: (id: string) => {
        locks.delete(id);
        change(id, { pending: false });
      },
      focus: new Map<string, Focus>(),
    };
  });
  return { drafts, ...tools };
}

const Shared = createContext<Drafts | null>(null);

/** Keeps the replies of the notices under it by notice id, unless a ReplyDrafts above it already does. */
export function ReplyDrafts({ children }: { children: ReactNode }) {
  const own = useDrafts();
  return <Shared.Provider value={useContext(Shared) ?? own}>{children}</Shared.Provider>;
}

const focusable = 'textarea, button';

/**
 * A notice's reply: kept by ReplyDrafts above the row when there is one, else the row's own (the gallery's flat lists).
 * `formId` is the reply form's id: focus in it, and the field's caret, go on to the row drawn anew in another group.
 */
export function useReplyDraft(id: string, formId: string) {
  const own = useDrafts();
  const { drafts, change, lock, unlock, focus } = useContext(Shared) ?? own;
  useLayoutEffect(() => {
    const controls = () => [...(document.getElementById(formId)?.querySelectorAll<HTMLElement>(focusable) ?? [])];
    const carried = focus.get(id);
    focus.delete(id);
    const target = carried && controls()[carried.at];
    if (target && (document.activeElement === null || document.activeElement === document.body)) {
      target.focus();
      if (carried.selection && target instanceof HTMLTextAreaElement) target.setSelectionRange(...carried.selection);
    }
    return () => {
      const active = document.activeElement;
      const at = controls().findIndex((control) => control === active);
      if (at < 0) return;
      const selection = active instanceof HTMLTextAreaElement ? ([active.selectionStart, active.selectionEnd] as const) : null;
      focus.set(id, { at, selection });
      // Taken by the row drawn anew in this same commit, if there is one; otherwise the notice has left, and it goes.
      queueMicrotask(() => focus.delete(id));
    };
  }, [id, formId, focus]);
  return {
    draft: drafts.get(id) ?? fresh,
    change: (next: Change) => change(id, next),
    lock: () => lock(id),
    unlock: () => unlock(id),
  };
}
