import { expect, test } from 'vitest';
import { parseShard, shardProblems, type ShardCounts } from './e2e-shards.ts';

const suite = { parallel: 327, serial: 33 };
const shards: ShardCounts[] = [
  { shard: '1/2', suite, ran: { parallel: 205, serial: 0 } },
  { shard: '2/2', suite, ran: { parallel: 122, serial: 33 } },
];

test('two shards that together ran the whole suite pass', () => {
  expect(shardProblems(shards)).toEqual([]);
});

test('a missing, repeated, empty or short shard fails', () => {
  expect(shardProblems([])).toEqual(['no shard reported its counts']);
  expect(shardProblems([shards[1]!])).toEqual([
    'shard 1/2 reported 0 times',
    'the parallel project ran 122 of 327 tests across the shards',
  ]);
  expect(shardProblems([shards[0]!, shards[0]!])).toEqual([
    'shard 1/2 reported 2 times',
    'shard 2/2 reported 0 times',
    'the parallel project ran 410 of 327 tests across the shards',
    'the serial project ran 0 of 33 tests across the shards',
  ]);
  expect(shardProblems([{ ...shards[0]!, ran: { parallel: 0, serial: 0 } }, shards[1]!])).toEqual([
    'shard 1/2 ran no tests',
    'the parallel project ran 122 of 327 tests across the shards',
  ]);
  expect(shardProblems([shards[0]!, { ...shards[1]!, shard: '2/3' }])).toContain('the shards disagree on their number: 1/2, 2/3');
  expect(shardProblems([shards[0]!, { ...shards[1]!, suite: { parallel: 300, serial: 33 } }])).toContain(
    'the shards listed different suites',
  );
});

test('E2E_SHARD is <current>/<total>', () => {
  expect(parseShard('2/2')).toEqual({ current: 2, total: 2 });
  for (const bad of ['', '2', '0/2', '3/2', '1/0', '1 / 2', 'a/b']) expect(() => parseShard(bad), bad).toThrow(/is not <current>\/<total>/);
});
