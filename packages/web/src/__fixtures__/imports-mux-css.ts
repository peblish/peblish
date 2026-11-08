// Deliberate boundary violation (tests/boundaries.test.ts): Mux UI's stylesheet outside the ui facade.
import '../../../ui/node_modules/@muxui/react/generated/styles.css';
import '@muxui/react/styles.css';
