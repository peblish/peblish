import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { format, resolveConfig } from 'prettier';
import { repoRoot } from './paths.ts';

/** JSON exactly as `prettier --check` wants it, so generated files pass the lint. */
export async function formatJson(value: unknown): Promise<string> {
  const config = await resolveConfig(join(repoRoot, 'package.json'));
  return format(JSON.stringify(value), { ...config, parser: 'json' });
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, await formatJson(value));
}
