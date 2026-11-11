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
