/** Hosts as a list in the reader's language ("a.example and b.example"). */
export const hostList = (locale: string, hosts: readonly string[]): string =>
  new Intl.ListFormat(locale, { type: 'conjunction' }).format(hosts);
