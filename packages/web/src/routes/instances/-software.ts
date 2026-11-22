// A peer's software name for people, shared by the Instances page and a profile's home instance.

/** How the common servers name themselves; any other NodeInfo name is shown as the peer gave it. */
const softwareNames: Readonly<Record<string, string>> = {
  lemmy: 'Lemmy',
  piefed: 'PieFed',
  mbin: 'Mbin',
  kbin: 'kbin',
  mastodon: 'Mastodon',
  peblish: 'peblish',
  friendica: 'Friendica',
  misskey: 'Misskey',
  pleroma: 'Pleroma',
  akkoma: 'Akkoma',
  sharkey: 'Sharkey',
  gotosocial: 'GoToSocial',
};

/** A peer's software as people read it, or null when this server does not know it. */
export const softwareName = (software: string | null) => (software === null ? null : (softwareNames[software] ?? software));
