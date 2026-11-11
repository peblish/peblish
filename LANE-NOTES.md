# FZ-FED lane notes

Lane FZ-FED (`fed-c`, port 18325), branch `mvp-w4-fz-fed` from tag `w4-final` (d268e4c). Item Z1 of `review-3-findings.md` ("Federation"), with root's response in `review-3-fixes.md`.

| Item                                                                                      | Commit  | Proving tests                                                                                                                    | Schema change |
| ----------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Z1 (P2) a fetch waiting on a database lookup when federation was paused could still start | b472a9d | `packages/federation/src/actors/federation-switch.test.ts` "a switch turned off during a database wait on the way out" (4 cases) | none          |

Each of the four tests was run with only its own fix taken out and failed there (the other three passed), and all four pass with the fix.

## 1. What landed

The federation switch is now read after every database wait on a request's way out, immediately before the request is handed to the fetcher below:

- `actors/document.ts` `fetchJson`: the headers (the User-Agent and, for a signed read, the signature, whose key is a database read) are prepared first, then the switch is read, then the request goes out. It is still read before every redirect hop, and still outside the try that would make it the peer's failure.
- `inbound/pipeline.ts` `fetchBudget`: after the lease renewal (`renewLease`), before the base fetcher. A pause there throws `FederationPaused`, which the pipeline already turns into a wait: the row goes back to pending with its attempt given back.
- `inbound/receive.ts`, the key-lookup fetcher: after the held-signer lookup (`namesHeldSigner`), before the lookup is charged to the key-lookup budget and before the base fetcher. The signature then answers `paused` and the POST gets 503 with Retry-After, as before.
- `resolve/limit.ts` (search): after the block check (`hostBlocked`), before the inner fetcher. The search answers `resolve.paused`. This wrapper was not named in the review; see decision 1.
- `actors/federation-switch.ts`: the header comment lists the four rechecks.

Proof, each forced, not timed (`gate` and `someoneWaitsOnALock` from `testing/seed-az.ts`):

1. Signed document read: another connection holds `lock table actor_keys in access exclusive mode`; the read passes its first check and waits on the signing key; the test sees the lock wait, turns the switch off, releases. Result: `FederationPaused`, no request.
2. Inbox row: the actor's document answers 301. When the first request is answered, another connection takes `for no key update` on the inbox row, so the redirect hop's lease renewal waits; the test turns the switch off during that wait and releases. Result: only the first request was sent; the row is `pending`, attempts 0, with the paused message.
3. Inbox POST from an unknown signer: the held-signer lookup turns the switch off while it runs (the `heldSigner` test option; decision 2). Result: 503 with `Retry-After: 300`, no key fetch, nothing stored.
4. Search by URL: another connection holds `lock table peer_controls in access exclusive mode`, so the block check waits; the switch goes off during it. Result: `resolve.paused`, no request.

## 2. Commits

1. b472a9d Read the federation switch after every database wait on a request's way out (Z1)
2. this file

## 3. Verification

- Each new test with its own fix removed (the others in place): fails. With all fixes: the switch test file passes, 16 tests.
- `pnpm check` before the Z1 commit: green on the first run, 2,704 passed, 10 skipped (242 files, 5 skipped). No reruns.
- `pnpm check` before this notes commit: green, the same counts.
- No e2e or lab run in this lane, as the brief says.

## 4. Decisions and deviations

1. Deviation (small, inside the write set): `resolve/limit.ts` also gets the recheck. Root's response named the document read and two inbound wrappers; the search wrapper has the same shape (a database read, the block check, before it forwards), so the same gap. It has its own forced test.
2. The held-signer lookup only reads (`select ... exists`), so no row lock makes it wait, and the table locks that would (`actors`, `actor_keys`) also stop the earlier key reads, where the old check would already catch the pause. So `ReceiveOptions` gets a test-only `heldSigner` option (default `namesHeldSigner`), the way `deliverDue` takes `refreshSoftware`; the test's lookup turns the switch off while it runs. The other three tests wait on a real lock.
3. In the key-lookup fetcher the recheck sits before `takeKeyLookup`, so a lookup stopped by a pause spends none of the key-lookup budget. It is read once per lookup, after the one wait (later fetches of the same lookup do no database work there, and `fetchJson` reads the switch before each).
4. In `fetchJson`, preparing the headers moved out of the try. Only `userAgent()` can throw there (`signatures` catches its own errors): a failure to read our own origin now surfaces as itself instead of being recorded as the peer `unreachable`. The origin is cached after the first read, so this matters only on a server that has not finished migrating.
5. Cost: one more settings read per request in the inbound pipeline and in a search, and one per key lookup.

## 5. Requests to root

None.

## 6. Requests to other lanes, through root

None. FZ-TOOLS's write set was not touched.

## 7. Dependencies added

None.

## 8. For later lanes

- A fetcher that awaits anything (a database read, a queue, a lease) before it forwards a request reads `assertFederationOn()` after that wait, immediately before forwarding. `fetchJson` lets `FederationPaused` through unchanged.

## 9. Left open and risks

- As before, a request already in flight when the switch flips is not stopped.
- `safeFetch` resolves the host's addresses before it connects; that is a network wait, not a database one, and the switch is not read again after it. Root's response covers the database waits; a pause landing in a DNS lookup still lets that one request go.
