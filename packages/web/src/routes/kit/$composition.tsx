import { Text } from '@peblish/ui/components/text';
import { createFileRoute, notFound } from '@tanstack/react-router';
import { useRouteHydrated } from '../../shell/hydration.ts';
import { kitEnabled } from './-enabled.ts';
import kitCss from './-kit.css?url';
import { compositions, kitStates } from './-states.tsx';

// A composition's states on one page (the compositions are in -states.tsx), for the shared state helper
// (e2e/support/states.ts) and for reading: one sample for each state it takes as a prop, each in a
// [data-kit-state] section. Like /kit, it answers 404 unless PEBLISH_UI_KIT=1.
export const Route = createFileRoute('/kit/$composition')({
  head: () => ({ links: [{ rel: 'stylesheet', href: kitCss }] }),
  beforeLoad: async ({ params }) => {
    if (!Object.hasOwn(compositions, params.composition) || !(await kitEnabled())) throw notFound();
  },
  component: StatePage,
});

function StatePage() {
  const { composition } = Route.useParams();
  const { name, states } = compositions[composition]!;
  useRouteHydrated();
  return (
    <main className="pb-page kit">
      <Text as="h1" variant="display" size="sm">
        {name}
      </Text>
      {kitStates.map((state) => {
        const Sample = states[state];
        return (
          Sample && (
            <section key={state} data-kit-state={state} aria-labelledby={`kit-state-${state}`}>
              <Text as="h2" variant="heading" size="sm" className="kit-heading kit-name" id={`kit-state-${state}`}>
                {state}
              </Text>
              <div className="kit-row" data-kit-sample>
                <Sample />
              </div>
            </section>
          )
        );
      })}
    </main>
  );
}
