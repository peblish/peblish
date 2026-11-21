import { Skeleton } from '@muxui/react';

// Every loading layout in skeletons.tsx draws its shapes through these: Mux UI's Skeleton shapes, each hidden
// from assistive technology. Not Skeleton.Root: each layout's group keeps its one status, and no shape moves
// (Root's sweep is an endless animation).

/** A share of the line's width, so rows differ like the text they stand for. */
export type Width = 100 | 90 | 80 | 70 | 60 | 50 | 40 | 30 | 20;

/** One line of text, as tall as the role it stands for (skeleton.css gives each role its type). */
export function SkelLine({ kind = 'body', width = 100 }: { kind?: 'title' | 'body' | 'meta' | 'label'; width?: Width }) {
  return <Skeleton.Line className="pb-skel-line" data-kind={kind} width={`${width}%`} />;
}

/** An avatar or community icon, at a control size. */
export function SkelCircle({ size = 'md' }: { size?: 'sm' | 'md' }) {
  return <Skeleton.Circle size={size} />;
}

/** A picture, by aspect ratio. */
export function SkelBlock({ ratio }: { ratio: 'wide' | 'thumb' }) {
  return <Skeleton.Block className="pb-skel-block" aspectRatio={ratio === 'wide' ? '16 / 9' : '4 / 3'} />;
}

/** A control pill (the vote, the comments count). */
export function SkelPill({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  return <Skeleton.Block className="pb-skel-pill" data-size={size} />;
}
