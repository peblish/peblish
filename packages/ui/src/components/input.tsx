import { Input as MuxInput, type InputRootProps } from '@muxui/react';
import type { Ref } from 'react';
import { useKeptValue } from './kept-value.ts';

export type { InputRootProps, InputControlProps, InputProps, InputLabelProps, InputDescriptionProps, InputErrorProps } from '@muxui/react';

/** Mux UI's Input.Root, keeping what was typed before the page hydrated (kept-value.ts). */
function Root({ ref, value, defaultValue, onChange, ...props }: InputRootProps & { ref?: Ref<HTMLDivElement> }) {
  return <MuxInput.Root {...props} {...useKeptValue({ value, defaultValue, onChange }, ref)} />;
}

/** Mux UI's Input parts, with the root above. */
export const Input = Object.freeze({ ...MuxInput, Root });
