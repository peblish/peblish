import { edgeConfig } from '@peblish/core/edge/config';
import { publicTags } from '@peblish/core/edge/public';
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
        // The answer may depend on who asks (a removed post's image for its moderators, a sensitive
        // community's banner), so it is read for this viewer and is `private`, unless edge caching
        // is configured and a signed-out visitor is shown the content: then it is public, and the
        // session is never read (-handler.ts). A refusal is never cached. The browser's Hide NSFW
        // cookies are not read: they decide how a page covers sensitive content, not whether the
        // viewer may see it (core media/reference.ts).
        const shown = async (content: MediaContent) => {
          const { session } = await formSession(request);
          const viewer: Viewer = session ? { actorId: session.view.actorId, siteRole: session.view.siteRole } : null;
          return contentShown(content, viewer);
        };
        return proxyResponse(params.signature, params.target, {
          key: await mediaProxyKey(),
          enabled: await readSetting('remote_media.enabled'),
          contentShown: shown,
          signal: request.signal,
          edge: edgeConfig() ? { publicTags: (content) => publicTags(content) } : null,
        });
      },
    },
  },
});
