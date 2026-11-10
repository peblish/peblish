import { parseNsfwChoice } from '@peblish/core/communities/gate';
import { mediaProxyKey, type MediaContent } from '@peblish/core/media/proxy-url';
import { contentShown } from '@peblish/core/media/reference';
import type { Viewer } from '@peblish/core/posts/read';
import { readSetting } from '@peblish/core/settings/read';
import { createFileRoute } from '@tanstack/react-router';
import { formSession } from '../../../../server/auth.ts';
import { proxyResponse } from '../-handler.ts';

// GET /media/proxy/<signature>/<target>: a remote image, fetched on the viewer's behalf. The
// URLs are made by siteMarkdown() (packages/web/src/server/markdown.ts) and imageSource().
export const Route = createFileRoute('/media/proxy/$signature/$target')({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        // The answer depends on who asks (a removed post's image, a gated community's banner), so
        // it is read for this viewer; it is `private`, and a refusal is never cached (-handler.ts).
        const shown = async (content: MediaContent) => {
          const { session } = await formSession(request);
          const viewer: Viewer = session ? { actorId: session.view.actorId, siteRole: session.view.siteRole } : null;
          return contentShown(content, viewer, parseNsfwChoice(request.headers.get('cookie')));
        };
        return proxyResponse(params.signature, params.target, {
          key: await mediaProxyKey(),
          enabled: await readSetting('remote_media.enabled'),
          contentShown: shown,
          signal: request.signal,
        });
      },
    },
  },
});
