import type { Density } from '../components/post-card.tsx';
import { ToggleButton, ToggleButtonGroup } from '../components/toggle-button-group.tsx';

export const densities = ['card', 'classic', 'compact'] as const satisfies readonly Density[];

export interface DensityControlLabels {
  /** The group's name: "View". */
  group: string;
  card: string;
  classic: string;
  compact: string;
}

const isDensity = (id: string | undefined): id is Density => densities.some((density) => density === id);

/**
 * The always-visible Card / Classic / Compact switch in a feed's toolbar: a Mux UI
 * ToggleButtonGroup with single selection (a radio group named "View"; each density is a radio).
 * It reports the new density; the web app stores it in the preferences cookie
 * (packages/web/src/shell/prefs.tsx).
 */
export function DensityControl({
  value,
  onChange,
  labels,
}: {
  value: Density;
  onChange: (density: Density) => void;
  labels: DensityControlLabels;
}) {
  return (
    <ToggleButtonGroup
      className="pb-density"
      aria-label={labels.group}
      size="sm"
      selectionMode="single"
      disallowEmptySelection
      selectedIds={[value]}
      onSelectionChange={([id]) => {
        if (isDensity(id)) onChange(id);
      }}
    >
      {densities.map((density) => (
        <ToggleButton key={density} id={density}>
          {labels[density]}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}
