import { authHead } from '../auth/-route.ts';
import settingsCss from './-ui/settings.css?url';

/**
 * Every settings page's head: the settings layout, and the auth stylesheet the shared form fields
 * (`auth/-ui/form.tsx`) still read until the AUTH lane moves them onto Mux. Its own module, with
 * no component in it: a route's head stays in the client entry (see `auth/-route.ts`).
 */
export const settingsHead = () => ({ links: [...authHead().links, { rel: 'stylesheet', href: settingsCss }] });
