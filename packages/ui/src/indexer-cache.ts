/**
 * Persistent indexer cache.
 *
 * The UI keeps a full copy of every announce / vote / start remark it
 * has observed, plus the highest block it's scanned through. Before
 * this module it was all in-memory: every browser reload re-scanned
 * from `startBlock` to head, which for a long-running proposal means
 * tens of thousands of block fetches on every page open.
 *
 * Now we snapshot `{ scannedThrough, remarks }` to localStorage under
 * a key namespaced by `(genesisHash, proposalId, startBlock)`. On
 * mount the hook restores the snapshot immediately, shows the cached
 * data as `ready`, and later catches up only the delta.
 *
 * Reorg safety: callers are expected to rescan the last SAFETY_MARGIN
 * blocks on resume and overwrite any cached entries in that window.
 * This file doesn't enforce that — it's a dumb blob store — but see
 * `useIndexer.ts` for where the margin is applied.
 *
 * Schema versioning: we bump `v` on any breaking change to the
 * IndexedRemark shape. A cache with a different `v` is discarded.
 */

import type { IndexedRemark } from './indexer';

const SCHEMA_VERSION = 1 as const;

interface CachePayload {
  v: typeof SCHEMA_VERSION;
  genesisHash: string;
  proposalId: string;
  startBlock: number;
  scannedThrough: number;
  remarks: IndexedRemark[];
  savedAt: string;
}

export interface CacheSlot {
  genesisHash: string;
  proposalId: string;
  startBlock: number;
}

export interface LoadedCache {
  scannedThrough: number;
  remarks: IndexedRemark[];
  savedAt: string;
}

function storageKey(slot: CacheSlot): string {
  return `anon-vote:indexer:v${SCHEMA_VERSION}:${slot.genesisHash}:${slot.proposalId}:${slot.startBlock}`;
}

function isValidPayload(x: unknown, slot: CacheSlot): x is CachePayload {
  if (!x || typeof x !== 'object') return false;
  const p = x as Partial<CachePayload>;
  return (
    p.v === SCHEMA_VERSION &&
    typeof p.genesisHash === 'string' &&
    p.genesisHash === slot.genesisHash &&
    typeof p.proposalId === 'string' &&
    p.proposalId === slot.proposalId &&
    typeof p.startBlock === 'number' &&
    p.startBlock === slot.startBlock &&
    typeof p.scannedThrough === 'number' &&
    p.scannedThrough >= slot.startBlock - 1 &&
    Array.isArray(p.remarks) &&
    typeof p.savedAt === 'string'
  );
}

/**
 * Read a snapshot for the given slot. Returns null for any kind of
 * miss — no cache, corrupt JSON, wrong schema, mismatched slot id.
 * Callers fall back to a full scan in that case.
 */
export function readCache(slot: CacheSlot): LoadedCache | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(storageKey(slot));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isValidPayload(parsed, slot)) return null;
    return {
      scannedThrough: parsed.scannedThrough,
      remarks: parsed.remarks,
      savedAt: parsed.savedAt,
    };
  } catch {
    // Corrupt JSON — drop it so next write starts fresh.
    try {
      localStorage.removeItem(storageKey(slot));
    } catch {
      // noop
    }
    return null;
  }
}

/**
 * Persist the current indexer state. Silent on quota errors — the
 * hook keeps working from memory; the user just loses the resume
 * benefit until there's less data to store.
 */
export function writeCache(
  slot: CacheSlot,
  snapshot: { scannedThrough: number; remarks: IndexedRemark[] },
): void {
  const payload: CachePayload = {
    v: SCHEMA_VERSION,
    genesisHash: slot.genesisHash,
    proposalId: slot.proposalId,
    startBlock: slot.startBlock,
    scannedThrough: snapshot.scannedThrough,
    remarks: snapshot.remarks,
    savedAt: new Date().toISOString(),
  };
  try {
    localStorage.setItem(storageKey(slot), JSON.stringify(payload));
  } catch (e) {
    // QuotaExceededError or SecurityError in private mode.
    console.warn('Indexer cache write failed:', e);
  }
}

/** Drop the snapshot — surfaced as a "Reset cache" action in the UI. */
export function clearCache(slot: CacheSlot): void {
  try {
    localStorage.removeItem(storageKey(slot));
  } catch {
    // noop
  }
}

/**
 * Drop EVERY indexer snapshot, regardless of slot. Used by the
 * "Reset cache" button when the user doesn't know (or we don't know)
 * which slot is relevant — e.g. after a genesis change.
 */
export function clearAllCaches(): void {
  try {
    const prefix = `anon-vote:indexer:v${SCHEMA_VERSION}:`;
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) keysToRemove.push(k);
    }
    for (const k of keysToRemove) localStorage.removeItem(k);
  } catch {
    // noop
  }
}
