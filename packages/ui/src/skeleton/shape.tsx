// The one file to swap when Mux UI's Skeleton family arrives (the next candidate): every loading
// layout in skeletons.tsx draws its shapes through these, static and unanimated until then.

/** A share of the line's width, so rows differ like the text they stand for. */
export type Width = 100 | 90 | 80 | 70 | 60 | 50 | 40 | 30 | 20;

/** One line of text, as tall as the role it stands for. */
export function SkelLine({ kind = 'body', width = 100 }: { kind?: 'title' | 'body' | 'meta' | 'label'; width?: Width }) {
  return <span className="pb-skel pb-skel--line" data-kind={kind} data-width={width} />;
}

/** An avatar or community icon. */
export function SkelCircle({ size = 'md' }: { size?: 'sm' | 'md' }) {
  return <span className="pb-skel pb-skel--circle" data-size={size} />;
}

/** A picture, by aspect ratio. */
export function SkelBlock({ ratio }: { ratio: 'wide' | 'thumb' }) {
  return <span className="pb-skel pb-skel--block" data-ratio={ratio} />;
}

/** A control pill (the vote, the comments count). */
export function SkelPill({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  return <span className="pb-skel pb-skel--pill" data-size={size} />;
}
