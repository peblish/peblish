import { definePlugin } from 'nitro';
import { renderCapSetting } from './render-cap.ts';

// A Nitro plugin (vite.config.ts): Nitro runs its plugins while it builds the app, before the
// server listens, and the SSR bundle that applies the setting loads only with the first ordinary
// request. So PEBLISH_RENDER_CAP is checked here, and a value it refuses stops the process at
// startup instead of failing every request after it.
export const checkRenderCapSetting = () => {
  renderCapSetting(process.env.PEBLISH_RENDER_CAP);
};

export default definePlugin(checkRenderCapSetting);
