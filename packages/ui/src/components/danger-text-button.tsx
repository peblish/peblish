import { Button, type ButtonProps } from '@muxui/react';

/**
 * A Mux Button that reads as a text link in the danger colour: the Delete in an action row,
 * beside plain links. It stays a real button (submit, name, value, pending), so forms and their
 * scripts-off behaviour are unchanged. Mux's danger-ghost variant gives the colour (its forced
 * colours included) and the focus ring; `pb-link-danger` (link.css) drops the box and adds the
 * link's underline. Mux gap (rc.7): no danger Link and no danger text token for apps.
 */
export function DangerTextButton({ className, ...props }: Omit<ButtonProps, 'variant' | 'size'>) {
  return <Button {...props} variant="danger-ghost" size="sm" className={['pb-link-danger', className].filter(Boolean).join(' ')} />;
}
