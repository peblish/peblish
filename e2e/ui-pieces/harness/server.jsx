// The harness's server render, bundled by build.mjs with React and Mux UI inside it, so the spec
// can import it from e2e/ without either installed there.
import { renderToString } from 'react-dom/server';
import { App } from './app.jsx';

/** The whole document for `url`; `assets` are the client bundle's script and stylesheets. */
export function render(url, assets) {
  const { search } = new URL(url);
  const scheme = new URLSearchParams(search).get('scheme') === 'dark' ? 'dark' : 'light';
  const css = assets.css.map((href) => `<link rel="stylesheet" href="${href}">`).join('');
  return (
    `<!doctype html><html lang="en-US" data-muxui-color-scheme="${scheme}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"><title>UI pieces</title>${css}` +
    `<script type="module" src="${assets.script}"></script></head>` +
    `<body><div id="root">${renderToString(<App search={search} />)}</div></body></html>`
  );
}
