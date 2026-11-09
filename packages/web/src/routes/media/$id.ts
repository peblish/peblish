import { createFileRoute } from '@tanstack/react-router';
import { mediaResponse } from './-serve.ts';

// /media/<id>: an uploaded image, once scanned clean. The static /media/proxy/... routes win over this one.
export const Route = createFileRoute('/media/$id')({
  server: {
    handlers: {
      GET: ({ params, request }) => mediaResponse(params.id, request),
      HEAD: ({ params, request }) => mediaResponse(params.id, request),
    },
  },
});
