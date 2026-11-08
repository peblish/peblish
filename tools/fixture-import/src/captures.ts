import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shapeOf } from '@peblish/federation/test/corpus';
import type { ManifestEntry } from '@peblish/federation/test/fixtures/manifest.schema';

// Reads the spike's capture files (see spikes/fedify-threadiverse/RESULT.md, "Files") and
// picks the wire documents of the corpus: what Lemmy 0.19.21 and PieFed 1.8.11 sent the
// spike, the actor and object documents it fetched from them, what the spike sent them,
// and what the peers' own logs show they sent elsewhere. Traffic from the lab's rogue peer
// and test harness (user agent `node`, host rogue.lab.test) is authorization testing, not
// dialect, and stays out, including the spike's relays of it. Each document id is kept
// once, from the first source below. The spike's own sends repeat a few shapes many times
// (each carries Fedify's 4 KB @context), so the first of each shape stands for the rest,
// except that every post and comment it published is kept (lab-live needs them).

export type Candidate = Pick<ManifestEntry, 'software' | 'direction' | 'source'> & { json: Record<string, unknown> };

/** The lab's servers and the versions RESULT.md records for them. */
export const lab = {
  'lemmy.lab.test': { name: 'lemmy', version: '0.19.21' },
  'piefed.lab.test': { name: 'piefed', version: '1.8.11' },
  'feddit.lab.test': { name: 'feddit-spike', version: '0.0.1' },
} as const;
type LabHost = keyof typeof lab;
export const isLabHost = (host: string): host is LabHost => host in lab;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const record = (value: unknown) => (isRecord(value) ? value : undefined);

function readLines(dir: string, file: string): { line: number; value: Record<string, unknown> }[] {
  const path = join(dir, file);
  if (!existsSync(path)) throw new Error(`capture file ${path} is missing`);
  return readFileSync(path, 'utf8')
    .split('\n')
    .flatMap((text, index) => (text.trim() === '' ? [] : [{ line: index + 1, value: record(JSON.parse(text)) ?? {} }]));
}

/** The post or comment a Create carries, also inside an Announce. */
function contentId(document: Record<string, unknown>): string | undefined {
  const object = record(document.object);
  if (!object) return undefined;
  if (document.type === 'Create' && typeof object.id === 'string') return object.id;
  return document.type === 'Announce' ? contentId(object) : undefined;
}

const host = (url: unknown) => (typeof url === 'string' ? new URL(url).host : '');
const iso = (value: unknown) => {
  const text = String(value);
  // PieFed's log stores naive UTC timestamps.
  return new Date(/[zZ]|[+-]\d{2}:\d{2}$/.test(text) ? text : `${text}Z`).toISOString();
};

export function readCandidates(dir: string): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const add = (candidate: Omit<Candidate, 'json'>, json: unknown) => {
    const document = record(json);
    if (!document || typeof document.id !== 'string' || typeof document.type !== 'string' || seen.has(document.id)) return;
    if (JSON.stringify(document).includes('rogue.lab.test')) return;
    const shape = candidate.direction === 'outbound' ? `outbound ${shapeOf(document)} ${contentId(document) ?? ''}` : undefined;
    if (shape !== undefined && seen.has(shape)) return;
    seen.add(document.id);
    if (shape !== undefined) seen.add(shape);
    out.push({ ...candidate, json: document });
  };

  for (const { line, value } of readLines(dir, 'inbound.jsonl')) {
    const agent = String(record(value.headers)?.['user-agent'] ?? '');
    const match = /^(Lemmy|PieFed)\/([\w.-]+)/.exec(agent);
    if (!match) continue;
    const software = { name: match[1] === 'Lemmy' ? 'lemmy' : 'piefed', version: match[2] ?? '' } as const;
    add({ software, direction: 'inbound', source: { file: 'inbound.jsonl', line, pointer: '/body', at: iso(value.ts) } }, value.body);
  }
  for (const { line, value } of readLines(dir, 'fetched.jsonl')) {
    const from = host(value.url);
    if (!isLabHost(from) || value.status !== 200) continue;
    add(
      { software: lab[from], direction: 'fetched', source: { file: 'fetched.jsonl', line, pointer: '/response', at: iso(value.ts) } },
      value.response,
    );
  }
  for (const { line, value } of readLines(dir, 'outbound.jsonl')) {
    const status = typeof value.status === 'number' ? value.status : 0;
    if (!isLabHost(host(value.url)) || status < 200 || status > 299) continue;
    add(
      {
        software: lab['feddit.lab.test'],
        direction: 'outbound',
        source: { file: 'outbound.jsonl', line, pointer: '/body', at: iso(value.ts) },
      },
      value.body,
    );
  }
  for (const { line, value } of readLines(dir, 'lemmy-sent_activity.jsonl')) {
    const data = typeof value.data === 'string' ? JSON.parse(value.data) : value.data;
    add(
      {
        software: lab['lemmy.lab.test'],
        direction: 'peer-log',
        source: { file: 'lemmy-sent_activity.jsonl', line, pointer: '/data', at: iso(value.published) },
      },
      data,
    );
  }
  for (const { line, value } of readLines(dir, 'piefed-activity_pub_log.jsonl')) {
    const json: unknown = typeof value.activity_json === 'string' ? JSON.parse(value.activity_json) : value.activity_json;
    // PieFed's log: what it sent ('out'), and what it received from Lemmy, which the spike never saw.
    const sender = host(record(json)?.actor);
    const software = value.direction === 'out' ? lab['piefed.lab.test'] : sender === 'lemmy.lab.test' ? lab['lemmy.lab.test'] : undefined;
    if (!software) continue;
    const source = {
      file: 'piefed-activity_pub_log.jsonl',
      line,
      pointer: '/activity_json',
      encoding: 'json-string',
      at: iso(value.created_at),
    } as const;
    add({ software, direction: 'peer-log', source }, json);
  }
  return out;
}
