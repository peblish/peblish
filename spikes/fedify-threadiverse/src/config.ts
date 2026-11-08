import { fileURLToPath } from "node:url";

/** Canonical origin. Fixed so URLs never depend on the Host header behind Caddy. */
export const ORIGIN = new URL(process.env.FEDDIT_ORIGIN ?? "https://feddit.lab.test");
export const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://feddit:feddit@localhost:5432/feddit";
export const PORT = Number(process.env.PORT ?? 8000);
export const CAPTURE_DIR =
  process.env.CAPTURE_DIR ?? fileURLToPath(new URL("../captures", import.meta.url));

export const SOFTWARE = { name: "feddit-spike", version: "0.0.1" } as const;

/** The instance's display name: NodeInfo `nodeName` and the instance actor's `name`. */
export const NODE_NAME = process.env.FEDDIT_NODE_NAME || "Feddit spike (lab)";

/**
 * When set, every `/spike/*` request must carry `Authorization: Bearer <token>`.
 * Required on any deployment the internet can reach; the lab leaves it unset.
 */
export const CONTROL_TOKEN = process.env.FEDDIT_CONTROL_TOKEN || undefined;

/**
 * Lab only. Fedify's SSRF guard rejects every IANA special-purpose block,
 * including the lab subnet (192.88.99.0/24) that Lemmy's and PieFed's looser
 * guards accept. Never set this outside lab/compose.yaml.
 */
export const ALLOW_PRIVATE_ADDRESS = process.env.FEDDIT_ALLOW_PRIVATE_ADDRESS === "1";

const numberFromEnv = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/**
 * Delivery policy for outbox.ts. Defaults suit production (about 11 hours of
 * retries); lab/compose.yaml shortens them so the retry scenarios finish fast.
 */
const REQUEST_TIMEOUT_MS = 15_000;

export const OUTBOX = {
  maxAttempts: numberFromEnv("FEDDIT_OUTBOX_MAX_ATTEMPTS", 10),
  baseDelayMs: numberFromEnv("FEDDIT_OUTBOX_BASE_DELAY_MS", 10_000),
  factor: 3,
  maxDelayMs: 6 * 60 * 60 * 1000,
  /**
   * A claimed row whose worker died becomes claimable again after this. Kept
   * above the request timeout, so a live worker's slow POST is never re-sent.
   */
  leaseMs: Math.max(numberFromEnv("FEDDIT_OUTBOX_LEASE_MS", 60_000), REQUEST_TIMEOUT_MS + 5_000),
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
} as const;
