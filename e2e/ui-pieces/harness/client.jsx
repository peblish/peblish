// The harness's browser entry: the app's two stylesheets, as the web app links them, and
// hydration of the server's markup. Hydration errors are kept on window for the spec.
import '../../../packages/ui/src/styles.css';
import '../../../packages/web/src/styles.css';
import './harness.css';
import { hydrateRoot } from 'react-dom/client';
import { App } from './app.jsx';

window.hydrationErrors = [];
hydrateRoot(document.getElementById('root'), <App search={location.search} />, {
  onRecoverableError: (error) => window.hydrationErrors.push(String(error)),
});
