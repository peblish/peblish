import { PanelLeftCloseIcon, PanelLeftOpenIcon } from './icons.tsx';
import { Sidebar } from './sidebar.tsx';
import { Tooltip } from './tooltip.tsx';

export interface EdgeToggleLabels {
  /** The button's name ("Sidebar"); `aria-expanded` says whether it is open. */
  name: string;
  /** The tooltip while open, and while folded. */
  collapse: string;
  expand: string;
}

/**
 * The round control on the sidebar's edge (Commons' EdgeToggle): Mux's Sidebar.Toggle, which folds the
 * Sidebar.Root of its Provider and owns `aria-expanded` and `aria-controls`, with a tooltip on hover and
 * keyboard focus that says what a press will do. Render it inside that Provider and pass its folded
 * state. Where it sits on the edge is the frame's to say (packages/web/src/shell/shell.css).
 */
export function EdgeToggle({ collapsed, labels, className }: { collapsed: boolean; labels: EdgeToggleLabels; className?: string }) {
  return (
    <div className={['pb-edge-toggle', className].filter(Boolean).join(' ')}>
      <Tooltip
        placement="end"
        offset={8}
        content={collapsed ? labels.expand : labels.collapse}
        trigger={
          <Sidebar.Toggle aria-label={labels.name} variant="ghost">
            {collapsed ? <PanelLeftOpenIcon /> : <PanelLeftCloseIcon />}
          </Sidebar.Toggle>
        }
      />
    </div>
  );
}
