import type { SettingsPatch } from '@peblish/core/settings/write';
import { customBannerContrast, customBannerMinimum, defaultBanner, SiteBanner, type BannerAction } from '@peblish/schema/banner';
import { killSwitches, SiteWidth } from '@peblish/schema/site-settings';
import { type } from 'arktype';

// The admin settings forms as patches for updateSettingsAs. Nothing is checked here: the
// service refuses what its contract refuses, and the page marks the field it names.

const lines = (value: string) =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

/** A browser sends a newline as CRLF; the contract counts and stores LF. */
const text = (value: string | undefined) => (value ?? '').replaceAll('\r\n', '\n');

/** The Save form: identity, operator, cap and the federation fields. A checkbox that is off is not in the form. */
export function savePatch(form: Record<string, string>): SettingsPatch {
  const cap = form['registration.cap'] ?? '';
  return {
    'site.name': text(form['site.name']),
    'site.description': text(form['site.description']),
    'operator.name': text(form['operator.name']),
    'operator.address': text(form['operator.address']),
    'operator.jurisdiction': text(form['operator.jurisdiction']),
    'contact.email': text(form['contact.email']),
    // NaN for anything but digits, which the contract refuses.
    'registration.cap': /^\d{1,9}$/.test(cap) ? Number(cap) : NaN,
    'remote_nsfw.accepted': form['remote_nsfw.accepted'] === 'on',
    'modlog.trusted_instances': lines(form['modlog.trusted_instances'] ?? ''),
  };
}

/** One kill switch's own form: the key and the state it should have, so a second click does nothing. Null for any other key. */
export function switchPatch(form: Record<string, string>): SettingsPatch | null {
  const key = killSwitches.find((name) => name === form.key);
  if (!key || (form.state !== 'on' && form.state !== 'off')) return null;
  const patch: Partial<Record<(typeof killSwitches)[number], boolean>> = {};
  patch[key] = form.state === 'on';
  return patch;
}

/** The banner form's fields, by their `name`; a refused form names the one to mark. */
export const bannerFields = [
  'banner.enabled',
  'banner.title',
  'banner.message',
  'banner.primary.label',
  'banner.primary.href',
  'banner.link.label',
  'banner.link.href',
  'banner.tone',
  'banner.colour',
  'banner.emphasis',
  'banner.align',
  'banner.icon',
  'banner.dismissible',
] as const;
export type BannerField = (typeof bannerFields)[number];

const isBannerField = (name: string): name is BannerField => (bannerFields as readonly string[]).includes(name);

/** `#rgb` as `#rrggbb`, so a colour typed with scripts off reads as the field would submit it. */
const colour = (value: string) => {
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value);
  return short
    ? `#${short
        .slice(1)
        .map((digit) => digit + digit)
        .join('')}`
    : value;
};

/**
 * The banner form as a `site.banner` patch: text trimmed and CRLF folded, an action only when it has a label or an
 * address, and `revision` 0, which the writer replaces with the next one. Refused, with the field to mark, where
 * the contract would refuse it or the form's own rules do: an enabled banner needs a message, and an action needs
 * both its label and its address, and a `banner.` field the form does not have is refused whole. A switch that
 * is off is not in the form.
 */
export function bannerPatch(form: Record<string, string>): { patch: SettingsPatch } | { field: BannerField | null } {
  // The banner is always published whole from its own fields: a post that names another `banner.` field (a
  // revision, say) is refused rather than have it dropped unseen. Null: no field of the form to mark.
  if (Object.keys(form).some((name) => name.startsWith('banner.') && !isBannerField(name))) return { field: null };
  const value = (name: BannerField) => text(form[name]).trim();
  const enabled = form['banner.enabled'] === 'on';
  const actions: Record<'primary' | 'link', BannerAction | null> = { primary: null, link: null };
  for (const slot of ['primary', 'link'] as const) {
    const label = value(`banner.${slot}.label`);
    const href = value(`banner.${slot}.href`);
    if (label && !href) return { field: `banner.${slot}.href` };
    if (href && !label) return { field: `banner.${slot}.label` };
    if (label) actions[slot] = { label, href };
  }
  const tone = value('banner.tone');
  const picked = colour(value('banner.colour'));
  const banner = {
    enabled,
    revision: 0,
    title: value('banner.title'),
    message: value('banner.message'),
    icon: value('banner.icon'),
    tone,
    // A colour only matters for Custom, whose field is hidden for the other tones: they keep the default where
    // it is empty or unreadable.
    colour: tone === 'custom' || /^#[0-9a-f]{6}$/i.test(picked) ? picked : defaultBanner.colour,
    emphasis: value('banner.emphasis'),
    align: value('banner.align'),
    dismissible: form['banner.dismissible'] === 'on',
    ...actions,
  };
  if (enabled && !banner.message) return { field: 'banner.message' };
  // The contract's contrast check of a custom colour, in both schemes (Mux draws the same fill in each).
  if (tone === 'custom' && (customBannerContrast(picked) ?? customBannerMinimum) < customBannerMinimum) return { field: 'banner.colour' };
  const checked = SiteBanner(banner);
  if (checked instanceof type.errors) {
    // The first problem's path, as the field that holds it: ['primary', 'href'] is banner.primary.href.
    const [head, tail] = checked[0]?.path.map(String) ?? [];
    const field = head === 'primary' || head === 'link' ? `banner.${head}.${tail === 'label' ? 'label' : 'href'}` : `banner.${head}`;
    return { field: isBannerField(field) ? field : 'banner.message' };
  }
  return { patch: { 'site.banner': checked } };
}

/** The width form's preset, else null. */
export function widthPatch(form: Record<string, string>): SettingsPatch | null {
  const width = SiteWidth(form['site.width']);
  return width instanceof type.errors ? null : { 'site.width': width };
}
