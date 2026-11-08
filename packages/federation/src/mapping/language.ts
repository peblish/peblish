import type { Json } from './json.ts';
import { Language } from './wire.ts';

// Lemmy and PieFed send `language: { identifier, name }` with the language's own name
// ('Deutsch'). Receivers read the identifier; the name is derived on the way out.

const special: Record<string, string> = { und: 'Undetermined', zxx: 'No linguistic content' };

/** The ISO 639 code of a Page or Note: `language.identifier`, else the only key of `contentMap` (Mbin, Mastodon). */
export function languageFromWire(
  language: typeof Language.infer | null | undefined,
  contentMap: Record<string, string> | undefined,
): string | null {
  if (language) return language.identifier;
  const keys = contentMap ? Object.keys(contentMap) : [];
  return keys.length === 1 ? (keys[0] ?? null) : null;
}

export function languageToWire(code: string | null): Json | undefined {
  if (code === null) return undefined;
  return { identifier: code, name: nativeName(code) };
}

function nativeName(code: string): string {
  const known = special[code];
  if (known) return known;
  try {
    const name = new Intl.DisplayNames([code], { type: 'language' }).of(code) ?? code;
    return name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
  } catch {
    return code;
  }
}
