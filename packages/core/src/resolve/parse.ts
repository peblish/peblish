import { maxLookupLength, type Lookup } from './outcome.ts';

// What a person typed into the resolve form, as a handle or a link. The handle grammar is
// federation's parseHandle (webfinger/client.ts), copied here because core imports no
// federation; a federation test holds the two together.

const handle = /^(?:acct:)?([@!])?([\w.-]+)@([a-z0-9.-]+(?::\d{1,5})?)$/i;

/**
 * `!name@host`, `@name@host`, `name@host`, or an https link. Null for anything else: empty, over
 * 500 characters, another scheme, or a link with a name or password in it.
 */
export function parseLookup(text: string): Lookup | null {
  const trimmed = text.trim();
  if (trimmed === '' || trimmed.length > maxLookupLength) return null;
  const match = handle.exec(trimmed);
  if (match) {
    const sigil = match[1] === '!' || match[1] === '@' ? match[1] : null;
    return { kind: 'handle', sigil, name: match[2]!, host: match[3]!.toLowerCase() };
  }
  if (!URL.canParse(trimmed)) return null;
  const url = new URL(trimmed);
  // Credentials in a link are never meant for us and would be sent to the host.
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
  return { kind: 'url', url: url.href };
}
