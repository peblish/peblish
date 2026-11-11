// A Mux UI link. With the app's router wired into LocaleProvider (packages/web/src/routes/__root.tsx),
// an internal href navigates without a page load; modified clicks still open a new tab.
export { Link, type LinkActivationEvent, type LinkProps } from '@muxui/react';
