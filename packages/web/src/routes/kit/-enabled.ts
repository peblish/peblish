import { createServerFn } from '@tanstack/react-start';

/** True where PEBLISH_UI_KIT=1 (CI and local e2e); everywhere else the component gallery is off. */
export const isKitEnabled = () => process.env.PEBLISH_UI_KIT === '1';

/** The route's guard: /kit answers 404 unless the gallery is on. */
export const kitEnabled = createServerFn({ method: 'GET' }).handler(isKitEnabled);
