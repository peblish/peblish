import { SearchField as MuxSearchField, type SearchFieldProps } from '@muxui/react';
import type { Ref } from 'react';
import { useKeptValue } from './kept-value.ts';

export type { SearchFieldProps } from '@muxui/react';

/** Mux UI's SearchField, keeping what was typed before the page hydrated (kept-value.ts). */
export function SearchField({ ref, value, defaultValue, onChange, ...props }: SearchFieldProps & { ref?: Ref<HTMLDivElement> }) {
  return <MuxSearchField {...props} {...useKeptValue({ value, defaultValue, onChange }, ref)} />;
}
