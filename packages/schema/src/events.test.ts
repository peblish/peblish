import { describe, expect, test } from 'vitest';
import { eventAreas } from './registry/events.gen.ts';
import { eventTypes, parseEvent, type EventOf } from './events.ts';

const created: EventOf<'post.created'> = {
  type: 'post.created',
  v: 1,
  postId: '0192f5a0-1234-7abc-8def-0123456789ab',
  communityId: '0192f5a0-1234-7abc-8def-0123456789ac',
  authorId: '0192f5a0-1234-7abc-8def-0123456789ad',
  local: true,
};

describe('outbox event union', () => {
  test('holds the initial members, each pinned to v 1', () => {
    expect(eventTypes).toEqual(
      expect.arrayContaining([
        'post.created',
        'vote.cast',
        'comment.created',
        'comment.updated',
        'comment.deleted',
        'actor.created',
        'actor.updated',
        'actor.deleted',
        'mod.ban',
        'mod.lock',
        'mod.feature',
        'mod.role',
        'report.created',
      ]),
    );
    expect(Object.keys(eventAreas).length).toBeGreaterThan(1);
  });

  test('parses a stored event back to its type', () => {
    expect(parseEvent(JSON.parse(JSON.stringify(created)))).toEqual(created);
  });

  test('rejects unknown types, unknown versions and missing fields', () => {
    expect(() => parseEvent({ ...created, type: 'post.exploded' })).toThrow(/unknown event type/);
    expect(() => parseEvent({ ...created, v: 2 })).toThrow();
    expect(() => parseEvent({ type: 'post.created', v: 1 })).toThrow();
  });
});
