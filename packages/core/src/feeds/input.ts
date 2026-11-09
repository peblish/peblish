import { type } from 'arktype';

// What a feed request is made of. Pure (ArkType only), so the web app can import the names and
// the defaults in a route's search validation and in the toolbar.

/** The five feeds: Subscribed (signed in), Local, All, Popular and Moderating (signed in). */
export const feedNames = ['subscribed', 'local', 'all', 'popular', 'moderating'] as const;
export const FeedName = type.enumerated(...feedNames);
export type FeedName = typeof FeedName.infer;

/** Hot, New, Old and Top. Active and Controversial are not built. */
export const sorts = ['hot', 'new', 'old', 'top'] as const;
export const Sort = type.enumerated(...sorts);
export type Sort = typeof Sort.infer;

/** The windows of Top, from the shortest to all time (D05). */
export const periods = ['1h', '6h', '12h', 'day', 'week', 'month', 'year', 'all'] as const;
export const Period = type.enumerated(...periods);
export type Period = typeof Period.infer;

export const defaultSort: Sort = 'hot';
export const defaultPeriod: Period = 'day';
export const defaultPageSize = 20;
export const maxPageSize = 50;
