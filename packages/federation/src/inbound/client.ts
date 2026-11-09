// The address of the client sending an inbox POST, for the budgets that count requests we cannot
// yet attribute to a peer (throttle.ts). Web's own clientIp (server/auth.ts) reads the same
// PEBLISH_TRUSTED_PROXY setting the same way; federation cannot import web, so the few lines are
// here, and the two must agree on what each setting means (deploy/README.md).

/**
 * The client's address: from a header only when the setting names the proxy that sets it
 * (Cloudflare's CF-Connecting-IP, or the entry Traefik appended last to X-Forwarded-For, since
 * any before it came from the client), otherwise the connection's peer. Null when none of them
 * is known.
 */
export function clientAddress(headers: Headers, peer: string | undefined, proxy = process.env.PEBLISH_TRUSTED_PROXY): string | null {
  const named =
    proxy === 'cloudflare'
      ? headers.get('cf-connecting-ip')
      : proxy === 'traefik'
        ? headers.get('x-forwarded-for')?.split(',').at(-1)
        : null;
  return named?.trim() || peer || null;
}

/** The peer address the server attached to the request (`request.ip`, which srvx sets), if any. */
export function peerOf(request: Request): string | undefined {
  return 'ip' in request && typeof request.ip === 'string' ? request.ip : undefined;
}
