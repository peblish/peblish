// Reads a field's server markup the way assistive technology links it: the control's
// aria-describedby ids, and the text of the elements they name. Shared by the field wrappers' tests.

const text = (html: string) => html.replace(/<[^>]+>/g, '').trim();

/** The first tag of `element` (input, textarea, select) in the markup. */
export function controlTag(html: string, element: 'input' | 'textarea' | 'select'): string {
  const tag = new RegExp(`<${element}\\b[^>]*>`).exec(html)?.[0];
  if (!tag) throw new Error(`no <${element}> in ${html}`);
  return tag;
}

/**
 * The text of every element the control's aria-describedby names, in order. In server markup React
 * Aria also names ids for parts that are not there (a description or error slot it resolves after
 * hydration); assistive technology skips an id nothing has, so these are left out.
 */
export function descriptionOf(html: string, element: 'input' | 'textarea' | 'select'): string[] {
  const ids = /aria-describedby="([^"]*)"/.exec(controlTag(html, element))?.[1]?.split(' ') ?? [];
  return ids.flatMap((id) => {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const found = new RegExp(`<(\\w+)[^>]*\\bid="${escaped}"[^>]*>(.*?)</\\1>`).exec(html);
    return found ? [text(found[2] ?? '')] : [];
  });
}

/** The text of every role="alert" in the markup. */
export const alertsOf = (html: string): string[] =>
  [...html.matchAll(/<span role="alert">(.*?)<\/span>/g)].map((match) => text(match[1] ?? ''));
