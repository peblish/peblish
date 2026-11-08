# Spikes

Each spike is self-contained, time-boxed and disposable. A spike reports a go/no-go against the pass criteria in `/Users/admin/.agents/plans/feddit/phase-0.md` and is not merged into product packages.

- `mux-start/`: Mux UI plus TanStack Start SSR and hydration gate (G1). Result: `mux-start/RESULT.md` (PASS, 2026-11-08).
- `fedify-threadiverse/`: Fedify-based Group actor federating with Lemmy 0.19.21 and PieFed 1.8.11 in the local lab (G2). Result: `fedify-threadiverse/RESULT.md` (slice 1 PASS and slice 2 PASS with three PieFed exceptions, 2026-11-08). Slice 2 added a durable outbox, guarded delivery, a single inbound pipeline with one authorization module, moderation handlers, an instance actor and negative scenarios.

Evidence folders (`*/e2e/artifacts/`, `*/captures/`) stay on disk and are gitignored.
