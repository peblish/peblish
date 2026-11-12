import { TextArea as MuxTextArea, type TextAreaRootProps } from '@muxui/react';
import type { Ref } from 'react';
import { useKeptValue } from './kept-value.ts';

export type { TextAreaRootProps, TextAreaProps, TextAreaLabelProps, TextAreaDescriptionProps, TextAreaErrorProps } from '@muxui/react';

/** Mux UI's TextArea.Root, keeping what was typed before the page hydrated (kept-value.ts). */
function Root({ ref, value, defaultValue, onChange, ...props }: TextAreaRootProps & { ref?: Ref<HTMLDivElement> }) {
  return <MuxTextArea.Root {...props} {...useKeptValue({ value, defaultValue, onChange }, ref)} />;
}

/** Mux UI's TextArea parts, with the root above. */
export const TextArea = Object.freeze({ ...MuxTextArea, Root });
