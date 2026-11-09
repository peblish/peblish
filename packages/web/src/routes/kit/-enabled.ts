import { createServerFn } from '@tanstack/react-start';

/** The component gallery answers only where PEBLISH_UI_KIT=1 (CI and local e2e); everywhere else /kit is a 404. */
export const kitEnabled = createServerFn({ method: 'GET' }).handler(() => process.env.PEBLISH_UI_KIT === '1');
