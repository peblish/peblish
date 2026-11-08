import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { nitro } from 'nitro/vite';
import { defineConfig } from 'vite';

// Plugin order follows the TanStack Start hosting guide: Start, then Nitro, then React.
export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 3000,
    // File events from a macOS bind mount did not reach the dev container; poll there instead.
    watch: process.env.VITE_USE_POLLING === '1' ? { usePolling: true, interval: 300 } : undefined,
  },
  plugins: [tanstackStart(), nitro({ preset: 'node-server' }), viteReact()],
});
