import type { ReactNode } from 'react';

/** The handle with its host dimmed: !news@lemmy.world. */
export function Handle({ prefix, handle }: { prefix: '!' | '@'; handle: string }): ReactNode {
  const at = handle.indexOf('@');
  return (
    <span className="pb-handle">
      {prefix}
      {at < 0 ? handle : handle.slice(0, at)}
      {at >= 0 && <span className="pb-handle__host">{handle.slice(at)}</span>}
    </span>
  );
}
