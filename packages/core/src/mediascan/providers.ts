import { arachnidProvider } from './arachnid.ts';
import type { ScanConfig } from './config.ts';
import type { ScanProvider } from './provider.ts';

/** The external providers the environment configures, in the order they are asked. The local list is not one: it always runs first. */
export function configuredProviders(config: ScanConfig): ScanProvider[] {
  return config.arachnid ? [arachnidProvider(config.arachnid)] : [];
}
