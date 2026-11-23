import { lazy, Suspense } from 'react';
import type { Composition } from './-states.tsx';
import type { SampleName } from './-finder-samples.tsx';

// The finder's and Create post's community field's state pages (/kit/<key>, f-finder lane), registered in -states.tsx.
// The registry is read with every page, so the samples, and the finder they draw, load only when a state page shows
// them (-finder-samples.tsx).
const Samples = lazy(() => import('./-finder-samples.tsx'));

const sample = (name: SampleName) =>
  function Sample() {
    return (
      <Suspense fallback={null}>
        <Samples name={name} />
      </Suspense>
    );
  };

export const finderPieces: Record<string, Composition> = {
  'community-finder': {
    name: 'Community finder',
    states: { rest: sample('results'), pending: sample('loading'), invalid: sample('error') },
  },
  'community-finder-empty': { name: 'Community finder, nothing typed yet', states: { rest: sample('empty') } },
  'community-finder-none': { name: 'Community finder, nothing matches', states: { rest: sample('none') } },
  'community-finder-lookup': { name: 'Community finder, a handle to find', states: { rest: sample('lookup') } },
  'community-field': {
    name: 'Community field',
    states: { rest: sample('field'), selected: sample('field-chosen'), invalid: sample('field-refused') },
  },
};
