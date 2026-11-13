import { renderToString } from 'react-dom/server';
import { expect, test } from 'vitest';
import { DangerTextButton } from './danger-text-button.tsx';

test('a Mux danger-ghost Button carrying the danger text look, still a submit button', () => {
  const html = renderToString(
    <DangerTextButton type="submit" name="intent" value="delete" className="extra">
      Delete
    </DangerTextButton>,
  );
  expect(html).toMatch(/^<button /);
  for (const part of [
    'type="submit"',
    'name="intent"',
    'value="delete"',
    'class="muxui-button pb-link-danger extra"',
    'data-muxui-variant="danger-ghost"',
  ])
    expect(html).toContain(part);
  expect(html).toContain('Delete');
});
