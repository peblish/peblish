import { BidiText } from '@peblish/ui/components/handle';
import { Fragment, type ReactNode } from 'react';

/**
 * A translated message with names from other servers in it, each in its own isolated run with
 * its directional controls removed. Build the message with the placeholders left in
 * (`t(key, { author: '{author}' })`); each `{name}` in `names` becomes a BidiText.
 */
export function withNames(message: string, names: Record<string, string>): ReactNode {
  return message.split(/(\{\w+\})/).map((piece, index) => {
    const name = /^\{(\w+)\}$/.exec(piece)?.[1];
    const text = name === undefined ? undefined : names[name];
    return <Fragment key={index}>{text === undefined ? piece : <BidiText text={text} />}</Fragment>;
  });
}

/** The placeholders for `names`, to pass to `t` so they stay in the message. */
export const placeholders = (names: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.keys(names).map((name) => [name, `{${name}}`]));
