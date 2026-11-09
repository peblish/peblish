import { expect, test } from 'vitest';
import { latestSaver } from './latest-saver.ts';

/** A save the test ends by hand. */
function manual() {
  const sent: string[] = [];
  const ends: ((error?: Error) => void)[] = [];
  const save = (value: string) => {
    sent.push(value);
    return new Promise<void>((resolve, reject) => ends.push((error) => (error ? reject(error) : resolve())));
  };
  const end = async (index: number, error?: Error) => {
    ends[index]?.(error);
    await new Promise((resolve) => setTimeout(resolve));
  };
  return { sent, save, end };
}

test('a value set during a save waits, and only the newest is sent after it', async () => {
  const { sent, save, end } = manual();
  const set = latestSaver(save);
  set('density');
  set('density+scheme');
  set('density+scheme+again');
  expect(sent).toEqual(['density']);
  await end(0);
  expect(sent).toEqual(['density', 'density+scheme+again']);
  await end(1);
  set('later');
  expect(sent).toEqual(['density', 'density+scheme+again', 'later']);
});

test('a failed save does not stop the next one', async () => {
  const { sent, save, end } = manual();
  const set = latestSaver(save);
  set('a');
  set('b');
  await end(0, new Error('offline'));
  expect(sent).toEqual(['a', 'b']);
});
