import type { Density } from '../components/post-card.tsx';

export const densities = ['card', 'classic', 'compact'] as const satisfies readonly Density[];

export interface DensityControlLabels {
  /** The group's name: "View". */
  group: string;
  card: string;
  classic: string;
  compact: string;
}

/**
 * The always-visible Card / Classic / Compact switch in a feed's toolbar. It reports the new
 * density; the web app stores it in the preferences cookie (packages/web/src/shell/prefs.tsx).
 * Plain pressed buttons, not Mux UI's ToggleButtonGroup: that adds about 38 kB gzip (its
 * animation code) to every feed, and this is a likely first tap.
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
    <div className="pb-segmented" role="group" aria-label={labels.group}>
      {densities.map((density) => (
        <button key={density} type="button" aria-pressed={value === density} onClick={() => onChange(density)}>
          {labels[density]}
        </button>
      ))}
    </div>
  );
}
