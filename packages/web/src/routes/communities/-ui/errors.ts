import type { MessageKey } from '../../../i18n/translate.ts';

// The refusals and web-only codes a join or leave can end in, each with a directory.error.<code>
// message in i18n/directory.json. Anything else is 'generic'.
export const directoryErrors = [
  'auth.required',
  'target.not_found',
  'community.banned',
  'community.removed',
  'community.deleted',
  'generic',
  'network',
] as const;

export type DirectoryError = (typeof directoryErrors)[number];

const known: ReadonlySet<string> = new Set(directoryErrors);

/** A code from the address or the server, as one the page has a message for. */
export function asDirectoryError(code: string | undefined | null): DirectoryError | undefined {
  if (!code) return undefined;
  return known.has(code) ? (code as DirectoryError) : 'generic';
}

export const errorKey = (code: DirectoryError): MessageKey<'directory'> => `directory.error.${code}`;
