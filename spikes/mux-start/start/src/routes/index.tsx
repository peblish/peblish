import { Link, createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/')({ component: Index });

function Index() {
  return (
    <main className="gate">
      <h1>Mux UI on TanStack Start</h1>
      <ul>
        <li>
          <Link to="/gate">/gate</Link> (RAC I18nProvider with the server-detected locale)
        </li>
        <li>
          <Link to="/gate-plain">/gate-plain</Link> (same content, no route-level I18nProvider; add ?i18n=root-locale or ?i18n=root-default for a root-level one)
        </li>
      </ul>
    </main>
  );
}
