// The action groups of the modlog page's facet rail (R2 pick modlog-feed), as action names. A
// name ending in ".*" matches every action under that prefix, so a lane that adds `settings.x`
// or `page.y` shows up under Site changes without an edit here.

export const actionGroups = {
  removals: ['mod.remove', 'mod.restore'],
  bans: ['mod.ban', 'mod.unban', 'mod.site_ban', 'mod.site_unban'],
  locks: ['mod.lock', 'mod.unlock', 'mod.pin', 'mod.unpin'],
  community: ['community.*'],
  site: ['settings.*', 'page.*', 'peer.update', 'report.*'],
} as const;

export type ActionGroup = keyof typeof actionGroups;

export const actionGroupNames = Object.keys(actionGroups) as ActionGroup[];

export const isActionGroup = (value: string): value is ActionGroup => value in actionGroups;
