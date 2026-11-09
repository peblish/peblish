import { type } from 'arktype';
import { ScanError, type ScanInput, type ScanProvider, type ScanVerdict } from './provider.ts';

// The Project Arachnid Shield adapter. `POST <base>/v1/media` takes the image bytes as the body
// and answers a classification (shield.projectarachnid.com/openapi.json: csam,
// harmful-abusive-material, test or no-known-match); `GET <base>/v1/version` says how fresh the
// hash list is. Basic auth is from the vendor SDK as remembered, not from the spec: confirm it
// on the account's API page when the registration lands (decisions.md, SAFE). The host is
// operator-set like S3, so this is a plain fetch and not safeFetch. Tested against a loopback
// stub only (testing/seed-safe.ts); no code path here calls the real host unless the operator
// sets ARACHNID_USERNAME and ARACHNID_PASSWORD.
//
// Nothing that can carry the credential leaves this file: errors say a class and a status, the
// request never follows a redirect (the Authorization header would go with it), and the raw
// answer that is kept is the response body, which does not echo the request.

const Answer = type({
  classification: "'csam' | 'harmful-abusive-material' | 'test' | 'no-known-match'",
  'match_type?': 'string',
  'near_match_details?': 'unknown[]',
});

/** Longest answer read, and longest raw answer kept in a manifest. */
const maxAnswerBytes = 64 * 1024;
const maxKeptBytes = 16 * 1024;

export type ArachnidOptions = {
  baseUrl: string;
  username: string;
  password: string;
  /** The global fetch, injectable for tests. */
  fetch?: typeof fetch;
};

async function readJson(response: Response): Promise<unknown> {
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength > maxAnswerBytes) throw new ScanError('Arachnid answer too large');
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new ScanError('Arachnid answer is not JSON');
  }
}

/** The answer as kept in the manifest: whole when small, else only the classification. */
function kept(answer: typeof Answer.infer): unknown {
  return JSON.stringify(answer).length <= maxKeptBytes ? answer : { classification: answer.classification, truncated: true };
}

function matchTypeOf(answer: typeof Answer.infer): 'exact' | 'near' | null {
  if (answer.match_type === 'exact' || answer.match_type === 'near') return answer.match_type;
  return answer.near_match_details && answer.near_match_details.length > 0 ? 'near' : null;
}

export function arachnidProvider(options: ArachnidOptions): ScanProvider {
  const call = options.fetch ?? fetch;
  const authorization = `Basic ${Buffer.from(`${options.username}:${options.password}`).toString('base64')}`;

  async function request(path: string, init: { method: 'GET' | 'POST'; body?: Uint8Array; contentType?: string }, signal: AbortSignal) {
    let response: Response;
    try {
      response = await call(`${options.baseUrl}${path}`, {
        method: init.method,
        headers: { authorization, accept: 'application/json', ...(init.contentType && { 'content-type': init.contentType }) },
        body: init.body ? Buffer.from(init.body) : undefined,
        redirect: 'error',
        signal,
      });
    } catch (error) {
      throw new ScanError(
        signal.aborted || (error instanceof Error && error.name === 'AbortError')
          ? 'Arachnid request timed out'
          : 'Arachnid request failed',
      );
    }
    if (!response.ok) throw new ScanError(`Arachnid answered HTTP ${response.status}`);
    return readJson(response);
  }

  return {
    name: 'arachnid',
    async scan({ bytes, mimeType }: ScanInput, signal: AbortSignal): Promise<ScanVerdict> {
      const answer = Answer(await request('/v1/media', { method: 'POST', body: bytes, contentType: mimeType }, signal));
      if (answer instanceof type.errors) throw new ScanError('Arachnid answer is malformed');
      if (answer.classification === 'no-known-match') return { result: 'no-match' };
      return { result: 'match', classification: answer.classification, matchType: matchTypeOf(answer), raw: kept(answer) };
    },
    async version(signal: AbortSignal) {
      const body = await request('/v1/version', { method: 'GET' }, signal);
      return JSON.stringify(body).slice(0, 200);
    },
  };
}
