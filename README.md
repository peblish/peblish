# Feddit

Working repository for Feddit, an open-source, ActivityPub-federated, Reddit-style community platform. The software name is provisional; "Feddit" is the flagship instance at feddit.com.

Status: Phase 0 (spikes and decisions). See `/Users/admin/.agents/plans/feddit/platform-comparison-and-recommendation.md` and `/Users/admin/.agents/plans/feddit/phase-0.md`.

- `plans/`: the July 2026 plan (client stack and roadmap superseded by the Nov 2026 recommendation; domain, federation, security and distribution sections still apply).
- `spikes/`: time-boxed, throwaway experiments that gate the architecture decision.
- `lab/`: Docker Compose federation lab (Lemmy, PieFed, Mbin) used by the spikes and later by interop tests.

Licensing (decided 2026-11-08): server and web app AGPL-3.0, UI kit and schema package MIT, DCO sign-off. No license files are added until the first real package exists.
