import { maxCommunityBlocks, maxInstanceBlocks, maxPersonBlocks } from '@peblish/core/blocks/limits';
import type { MessageKey } from '../../../../i18n/translate.ts';
import type { BlockTab } from '../-tabs.ts';

const max: Record<BlockTab, number> = { people: maxPersonBlocks, communities: maxCommunityBlocks, instances: maxInstanceBlocks };

/** The blocks.json message for a code from the server or the address, with its parameters; null for an unknown code. */
export function blockError(
  code: string | undefined,
  tab: BlockTab,
  query: string | undefined,
): { key: MessageKey<'blocks'>; params: Record<string, string | number> } | null {
  switch (code) {
    case 'handle.not_found':
      return { key: 'error.handle.not_found', params: { query: query ?? '' } };
    case 'handle.invalid':
    case 'block.limit':
      return { key: `error.${code}.${tab}` as MessageKey<'blocks'>, params: { max: max[tab] } };
    case 'auth.site_banned':
    case 'block.own_instance':
    case 'target.protected':
    case 'gone':
    case 'form.invalid':
    case 'generic':
    case 'network':
      return { key: `error.${code}`, params: {} };
    default:
      return code ? { key: 'error.generic', params: {} } : null;
  }
}
