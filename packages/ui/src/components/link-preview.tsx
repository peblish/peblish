import { neutraliseBidi } from './handle.tsx';
import { ExternalLinkIcon } from './icons.tsx';
import { Link } from './link.tsx';
import { Text } from './text.tsx';

export interface LinkPreviewProps {
  /** Where the post links. Null shows the domain as plain text, with no link (a removed post's). */
  href: string | null;
  /** The host the link goes to, as the reader judges it: "example.com". */
  domain: string;
  className?: string;
}

/**
 * The line under a link post that says where its link goes: an external-link glyph and the domain,
 * as a Mux Link (named by the domain) that opens the address itself. The domain comes from someone
 * else's URL, so it is isolated and left to right, like a handle's host.
 */
export function LinkPreview({ href, domain, className }: LinkPreviewProps) {
  const classes = ['pb-link-preview', className].filter(Boolean).join(' ');
  const content = (
    <>
      <ExternalLinkIcon />
      <bdi dir="ltr" className="pb-link-preview__domain">
        {neutraliseBidi(domain)}
      </bdi>
    </>
  );
  return href ? (
    <Link className={classes} href={href} rel="noopener noreferrer nofollow ugc">
      {content}
    </Link>
  ) : (
    <Text size="sm" color="muted" className={classes} data-disabled="">
      {content}
    </Text>
  );
}
