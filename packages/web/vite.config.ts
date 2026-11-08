import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { nitro } from 'nitro/vite';
import { defineConfig } from 'vite';

// Plugin order follows the TanStack Start hosting guide: Start, then Nitro, then React.
// Dev and preview use the lane's port (G0 18300; scripts/lane.sh prints each lane's).
export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: Number(process.env.PORT ?? 18300),
    strictPort: true,
    // File events from a macOS bind mount do not reach a container; poll there instead.
    watch: process.env.VITE_USE_POLLING === '1' ? { usePolling: true, interval: 300 } : undefined,
  },
  resolve: { dedupe: ['react', 'react-dom'] },
  plugins: [
    tanstackStart(),
    // Without '!unwasm', shiki/wasm (pulled in by @muxui/react through @peblish/ui) resolves to
    // onig.wasm, which the SSR environment's bundler cannot link. The JS loader works the same.
    nitro({ preset: 'node-server', exportConditions: ['!unwasm'] }),
    viteReact(),
  ],
});
