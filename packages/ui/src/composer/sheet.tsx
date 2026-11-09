import type { ReactNode } from 'react';
import { Dialog } from '../components/dialog.tsx';

export interface ComposerSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The sheet's heading, which also names it for assistive technology. */
  title: string;
  children: ReactNode;
}

/**
 * The composer as a bottom sheet (composer-page, opened over the feed): the modal dialog with
 * its panel pinned to the bottom edge, covering most of the viewport, sliding up when it opens.
 * The page underneath stays mounted; the dialog makes it inert while the sheet is open.
 */
export function ComposerSheet({ open, onOpenChange, title, children }: ComposerSheetProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      panelClassName="pb-sheet"
      backdropClassName="pb-sheet__backdrop"
      contentClassName="pb-sheet__content"
    >
      {children}
    </Dialog>
  );
}
