// Pure host helpers shared by the peer gates and the image source (media/image-src.ts). Hosts
// are compared as URL.host gives them: lowercase, with the port when it is not the default.

/** Whether `host` is `domain` or a subdomain of it. */
export function hostUnder(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** `host` and each parent domain above it, most specific first (a.b.example, b.example, example). */
export function hostAndParents(host: string): string[] {
  const labels = host.split('.');
  return labels.map((_, index) => labels.slice(index).join('.'));
}
