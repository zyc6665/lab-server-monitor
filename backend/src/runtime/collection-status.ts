/**
 * In-memory collection-status registry (P5 Task 11b).
 *
 * The scheduler's `collect` cycle and the hosts routes' `collectionStatus`
 * provider need to share per-host progress without persisting it. This mirrors
 * `servermanage/app.py::ServerMonitor._collection_states`:
 *
 *   `{ state: 'pending'|'running'|'done'|'error'|'unknown', started_at,
 *      finished_at, error }`
 *
 * The registry is keyed by database identity (a `WeakMap`) so a composition
 * root that builds its deps once and a scheduler wiring that runs later in the
 * same process observe the same state, while tests with fresh databases never
 * leak state across cases.
 */

/** Per-host collection lifecycle state. */
export type CollectionState = 'pending' | 'running' | 'done' | 'error' | 'unknown';

/** One host's collection status (snake_case to mirror the Python dict). */
export interface CollectionStatusEntry {
  state: CollectionState;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
}

/** Mutable registry of per-host collection statuses. */
export class CollectionStatusRegistry {
  private readonly states = new Map<string, CollectionStatusEntry>();

  private set(name: string, entry: CollectionStatusEntry): void {
    this.states.set(name, entry);
  }

  private prior(name: string, now: Date): CollectionStatusEntry {
    const prev = this.states.get(name);
    if (prev) {
      return prev;
    }
    return { state: 'pending', started_at: now.toISOString(), finished_at: null, error: null };
  }

  /** Marks `names` queued but not yet started. */
  markPending(names: readonly string[], now: Date = new Date()): void {
    for (const name of names) {
      this.set(name, {
        state: 'pending',
        started_at: now.toISOString(),
        finished_at: null,
        error: null,
      });
    }
  }

  /** Marks `names` as actively collecting (preserves `started_at`). */
  markRunning(names: readonly string[], now: Date = new Date()): void {
    for (const name of names) {
      const prev = this.prior(name, now);
      this.set(name, {
        state: 'running',
        started_at: prev.started_at ?? now.toISOString(),
        finished_at: null,
        error: null,
      });
    }
  }

  /** Marks `names` as successfully collected. */
  markDone(names: readonly string[], now: Date = new Date()): void {
    for (const name of names) {
      const prev = this.prior(name, now);
      this.set(name, {
        state: 'done',
        started_at: prev.started_at ?? now.toISOString(),
        finished_at: now.toISOString(),
        error: null,
      });
    }
  }

  /** Marks `names` as failed with the given error message. */
  markError(names: readonly string[], error: string, now: Date = new Date()): void {
    for (const name of names) {
      const prev = this.prior(name, now);
      this.set(name, {
        state: 'error',
        started_at: prev.started_at ?? now.toISOString(),
        finished_at: now.toISOString(),
        error,
      });
    }
  }

  /**
   * Returns a plain object snapshot. When `names` is `null` the snapshot covers
   * every known host; otherwise it covers exactly the requested names, filling
   * unseen hosts with `unknown` (matching the Python provider contract).
   */
  snapshot(names: readonly string[] | null = null): Record<string, CollectionStatusEntry> {
    const out: Record<string, CollectionStatusEntry> = {};
    const targets =
      names === null || names === undefined ? Array.from(this.states.keys()) : names;
    for (const name of targets) {
      out[name] = this.states.get(name) ?? {
        state: 'unknown',
        started_at: null,
        finished_at: null,
        error: null,
      };
    }
    return out;
  }
}

const registries = new WeakMap<object, CollectionStatusRegistry>();

/** Returns the registry bound to `db` (creating it on first use). */
export function getCollectionStatusRegistry(db: object): CollectionStatusRegistry {
  let registry = registries.get(db);
  if (!registry) {
    registry = new CollectionStatusRegistry();
    registries.set(db, registry);
  }
  return registry;
}
