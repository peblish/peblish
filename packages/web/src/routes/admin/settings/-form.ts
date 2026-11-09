import type { SettingsPatch } from '@peblish/core/settings/write';
import { killSwitches } from '@peblish/schema/site-settings';

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
