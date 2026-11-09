/** A `{{TOKEN}}` in a page's Markdown: operator details and dates the shipped legal texts leave to be filled. */
const TOKEN = /\{\{[A-Z0-9_]+\}\}/g;

/** The tokens publishing fills itself; every other one is still a gap the admin must write over. */
export type TokenValues = {
  OPERATOR_NAME: string;
  POSTAL_ADDRESS: string;
  JURISDICTION: string;
  CONTACT_EMAIL: string;
  /** UTC `YYYY-MM-DD` of the moment of publishing. */
  EFFECTIVE_DATE: string;
};

/** The distinct tokens in `text`, in order of appearance. */
export const tokensIn = (text: string): string[] => [...new Set(text.match(TOKEN) ?? [])];

/**
 * `text` with the known tokens that have a value filled in, in one pass (a value is never filled
 * again), and every token the result still holds: the unknown ones, the known ones whose value
 * is empty, and any a value brought in (an operator detail that is or contains `{{TOKEN}}`, or
 * completes one with the text beside it). Publishing refuses while any stand, so a placeholder
 * never reaches visitors, whichever way it got there.
 */
export function fillTokens(text: string, values: TokenValues): { text: string; unresolved: string[] } {
  const filled = text.replace(TOKEN, (token) => {
    const value = Object.hasOwn(values, token.slice(2, -2)) ? values[token.slice(2, -2) as keyof TokenValues] : '';
    return value.trim() === '' ? token : value;
  });
  return { text: filled, unresolved: tokensIn(filled) };
}

/** A postal address on one line, for running text: its lines joined with commas. */
export const oneLine = (address: string) =>
  address
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(', ');

/** The UTC date of `at` as `YYYY-MM-DD`. */
export const utcDate = (at: Date) => at.toISOString().slice(0, 10);
