import { createFileRoute } from '@tanstack/react-router';

/** Negative control: renders different text on server and client, so the e2e detector must fire. */
export const Route = createFileRoute('/mismatch-probe')({ component: MismatchProbe });

function MismatchProbe() {
  return <p data-testid="probe">{typeof window === 'undefined' ? 'server render' : 'client render'}</p>;
}
