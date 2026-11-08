// The image's Docker HEALTHCHECK, by role: PEBLISH_PROCESS from the container environment,
// which the entrypoint requires to match the process it starts.
// - web: GET /healthz on $PORT must answer 200 within 4 s.
// - worker: healthy without a probe. It serves no HTTP; its liveness is the process (the
//   container stops when it exits, and the restart policy brings it back), and a stalled
//   outbox shows in the worker's lag warning.
// - migrate: healthy without a probe; a one-shot run that exits.
// Anything else (unset, a typo) is unhealthy, so a misconfigured container is visible.
const role = process.env.PEBLISH_PROCESS;
if (role === 'worker' || role === 'migrate') process.exit(0);
if (role !== 'web') {
  console.error(`healthcheck: PEBLISH_PROCESS is ${role === undefined ? 'unset' : `'${role}'`}, not web, worker or migrate`);
  process.exit(1);
}
const response = await fetch(`http://127.0.0.1:${process.env.PORT ?? 3000}/healthz`, { signal: AbortSignal.timeout(4_000) }).catch(
  () => undefined,
);
process.exit(response?.ok ? 0 : 1);
