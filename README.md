# peblish

peblish is an open-source, ActivityPub-federated, Reddit-style community platform written in TypeScript (Fedify, TanStack Start, Mux UI). Its flagship instance is [feddit.com](https://feddit.com). The repository name and this README reflect the decisions of 2026-11-08; the platform is in Phase 0 (gates and decisions) and has no product code yet.

Status and plans: `/Users/admin/.agents/plans/feddit/platform-comparison-and-recommendation.md` and `/Users/admin/.agents/plans/feddit/phase-0.md` on the maintainer's machine (to be published with the first product milestone).

- `plans/`: the July 2026 plan (client stack and roadmap superseded by the November 2026 recommendation; domain, federation, security and distribution sections still apply).
- `spikes/`: time-boxed, throwaway experiments that gated the architecture decision. Both passed on 2026-11-08; see each `RESULT.md`.
- `lab/`: Docker Compose federation lab (Lemmy 0.19.21, PieFed 1.8.11, Caddy with internal TLS, all networks internal) used by the spikes and later by interop tests.

Licensing (decided 2026-11-08): server and web app AGPL-3.0, UI kit and schema package MIT, DCO sign-off. License files are added with the first real package.
