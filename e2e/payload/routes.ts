// The routes the payload budget covers (budget.spec.ts), each measured on a first visit with
// a cold cache. A lane that adds a page asks root to add its path here; the check then holds
// that page to the same budget.
export interface PayloadRoute {
  path: string;
  /** The composer: the one route that may load the editor's lazy chunk (vendor-editor). */
  composer?: true;
  /** Renders regular, italic and code text, so it is where the font budget is measured. */
  fonts?: true;
}

export const routes: readonly PayloadRoute[] = [{ path: '/' }, { path: '/auth/sign-in' }, { path: '/kit', fonts: true }];
