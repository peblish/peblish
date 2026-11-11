import type { ReactNode } from 'react';

// Names and hosts from other servers can carry directional controls (embeddings, overrides,
// isolates and marks) that would reorder the text around them: `jun<U+202E>...@evil.example`
// could be drawn to read as another account on another server. Escapes only in this file.
const bidiControls = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/g;

/**
 * `text` with every directional control character replaced, for display only: by an interrobang
 * (U+203D) by default, so a handle that carries one looks different from the account it imitates.
 * Not U+FFFD: the Inter Latin slice the pages load has no glyph for it, so drawing one fetched the
 * whole font file. Links and lookups keep the exact value.
 */
export function neutraliseBidi(text: string, replacement = '\u203D'): string {
  return text.replace(bidiControls, replacement);
}

/** The host of a handle, what follows its last `@` (`lemmy.world` for `news@lemmy.world`), or '' for a local handle. */
export function handleHost(handle: string): string {
  const at = handle.lastIndexOf('@');
  return at < 0 ? '' : handle.slice(at + 1);
}

/** Text from another server (a display name) in its own isolated run, its directional controls removed. */
export function BidiText({ text }: { text: string }): ReactNode {
  return <bdi>{neutraliseBidi(text, '')}</bdi>;
}

/**
 * The handle with its host dimmed: !news@lemmy.world. The whole handle is left to right and
 * isolated from the text around it; the prefixed name and the host are separate left-to-right
 * isolated runs (a name is one word, so a right-to-left one still reads right), so nothing in the
 * name can move the host. The host is what follows the last @.
 */
export function Handle({ prefix, handle }: { prefix: '!' | '@'; handle: string }): ReactNode {
  const at = handle.lastIndexOf('@');
  return (
    <span className="pb-handle" dir="ltr">
      <bdi className="pb-handle__name" dir="ltr">
        {prefix + neutraliseBidi(at < 0 ? handle : handle.slice(0, at))}
      </bdi>
      {at >= 0 && (
        <bdi className="pb-handle__host" dir="ltr">
          {neutraliseBidi(handle.slice(at))}
        </bdi>
      )}
    </span>
  );
}
