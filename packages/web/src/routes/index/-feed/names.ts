import type { FeedName } from '@peblish/core/feeds/input';
import type { MessageKey } from '../../../i18n/translate.ts';
import type { FeedRoute } from './route.ts';

/** Each feed's name, in the shell's catalogue (the feed's view header and its rail). */
export const feedTitleKeys = {
  subscribed: 'feed.subscribed',
  local: 'feed.local',
  all: 'feed.all',
  popular: 'feed.popular',
  moderating: 'feed.moderating',
} as const satisfies Record<FeedName, MessageKey<'shell'>>;

/** The feed a route shows: the front page's is Subscribed for a signed-in person, Local for anyone else. */
export const routeFeed = (route: FeedRoute, signedIn: boolean): FeedName =>
  route === 'home' ? (signedIn ? 'subscribed' : 'local') : route;
