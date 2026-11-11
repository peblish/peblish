import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { VoteControl } from './vote-control.tsx';

// Other areas' browser tests read the vote by role: a group named for the vote, two buttons with
// aria-pressed (not a radio group), and the score between them.
test('the server renders a named group of two pressed-state arrows around the score', () => {
  const html = renderToStaticMarkup(
    <VoteControl score={1234} myVote={1} labels={{ group: 'Vote', up: 'Upvote', down: 'Downvote' }} locale="en-US" disabled />,
  );
  expect(html).toMatch(/^<div aria-label="Vote"[^>]*role="group"/);
  expect(html).toMatch(/aria-label="Upvote"[^>]*aria-pressed="true"/);
  expect(html).toMatch(/aria-label="Downvote"[^>]*aria-pressed="false"/);
  expect(html).toContain('>1,234<');
  expect(html).toContain('data-vote="up"');
  expect(html).not.toContain('role="radio');
});

test('a label names the group in place of the plain group name; without one the group keeps it', () => {
  const labels = { group: 'Vote', up: 'Upvote', down: 'Downvote' };
  const named = renderToStaticMarkup(<VoteControl score={1} myVote={0} labels={labels} label="Vote on A post" locale="en-US" />);
  expect(named).toMatch(/^<div aria-label="Vote on A post"[^>]*role="group"/);
  expect(renderToStaticMarkup(<VoteControl score={1} myVote={0} labels={labels} locale="en-US" />)).toMatch(/^<div aria-label="Vote"/);
});
