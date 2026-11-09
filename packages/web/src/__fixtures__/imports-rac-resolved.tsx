// Deliberate boundary violation (tests/boundaries.test.ts): React Aria reached by a resolved path.
// Nothing hoists React Aria to the root any more, so the bare specifier no longer resolves from
// web; pnpm's private hoist directory still holds the single copy @muxui/react uses.
import { Button } from '../../../../node_modules/.pnpm/node_modules/react-aria-components/dist/exports/index.mjs';

export const violation = Button;
