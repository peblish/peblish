// Deliberate boundary violation (tests/boundaries.test.ts): a module allowed to use the write
// pool re-exports it, which would hand it to every importer of this file.
export { writer } from '../../db/write.ts';
