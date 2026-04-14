/**
 * Resolve Bittensor identities for a list of voter hotkeys.
 *
 * Bittensor's SubtensorModule pallet owns two relevant storage items:
 *
 *   owner(hotkey)          -> coldkey (the account the hotkey delegates to)
 *   identitiesV2(coldkey)  -> { name, url, image, discord, ... } | null
 *
 * We walk the voter list once, hotkey → coldkey → identity, and
 * surface a normalized `{ coldkey, name }` per hotkey. Missing
 * records resolve to `null` fields and the caller renders "unknown".
 *
 * Throttled by the chain RPC — polkadot.js batches these into the
 * same websocket but we still fire one request per voter. For a
 * senate of ~12 that's negligible; a larger senate would want
 * `api.query.subtensorModule.identitiesV2.multi([...coldkeys])`.
 */

import { useEffect, useState } from 'react';
import { getApi } from '../subtensor';

/**
 * SS58 representation of the all-zeros AccountId32. polkadot.js
 * decodes an absent `StorageMap<_, AccountId>` entry to this. When
 * `subtensorModule.owner(hk)` returns this, it means "no entry" —
 * i.e. the hotkey was never registered on Subtensor, so there is
 * no owner coldkey to speak of. We treat it as null downstream.
 */
const ZERO_ACCOUNT = '5C4hrfjw9DjXZTzV3MwzrrAr9P1MJhSrvWGWqi1eSuyUpnhM';

export interface VoterIdentity {
  coldkey: string | null;
  /** Display name from identitiesV2, or null if unset/absent. */
  name: string | null;
}

export interface VoterIdentitiesState {
  /** Map hotkey → resolved identity (undefined entry = still loading). */
  byHotkey: Map<string, VoterIdentity>;
  loading: boolean;
  error: string | null;
}

function hexToUtf8(hex: string): string {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length === 0 || clean.length % 2 !== 0) return '';
  try {
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < clean.length; i += 2) {
      bytes[i / 2] = Number.parseInt(clean.slice(i, i + 2), 16);
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return '';
  }
}

/**
 * Extract the `name` field from an `identitiesV2` query result.
 *
 * Real-world shape on Subtensor: the query returns either `None` or
 * `Some(struct { name: Bytes, url: Bytes, ... })`. The working
 * approach (matching existing tooling) is:
 *
 *   1. Drop on `isNone`.
 *   2. Unwrap when `isSome`.
 *   3. Read `inner.name` — it's itself a Codec (Bytes).
 *   4. Call `.toHuman()` on that field, which gives the UTF-8
 *      decoded string directly. `0x` (empty bytes) → "" → null.
 *
 * Calling `.toJSON()` / `.toHuman()` on the whole struct is fragile
 * across polkadot.js versions; per-field is stable.
 */
function extractName(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const codec = raw as {
    isNone?: boolean;
    isSome?: boolean;
    unwrap?: () => unknown;
  };
  if (codec.isNone === true) return null;
  const inner =
    codec.isSome === true && typeof codec.unwrap === 'function'
      ? codec.unwrap()
      : raw;
  if (!inner || typeof inner !== 'object') return null;

  const nameField = (inner as { name?: unknown }).name as
    | { toHuman?: () => unknown; toString?: () => string; toU8a?: () => Uint8Array }
    | undefined;
  if (!nameField) return null;

  // Prefer .toHuman() — on a Bytes Codec it returns the UTF-8 string
  // directly (e.g. "Polychain" for the `0x506f6c79636861696e` bytes).
  let str: string | null = null;
  try {
    const h = nameField.toHuman?.();
    if (typeof h === 'string') str = h;
  } catch {
    // fall through to toString fallback
  }
  if (str === null) {
    try {
      const s = nameField.toString?.();
      if (typeof s === 'string') {
        str = s.startsWith('0x') ? hexToUtf8(s) : s;
      }
    } catch {
      str = null;
    }
  }
  if (str === null) return null;
  const trimmed = str.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function useVoterIdentities(
  hotkeys: readonly string[],
): VoterIdentitiesState {
  const [state, setState] = useState<VoterIdentitiesState>({
    byHotkey: new Map(),
    loading: true,
    error: null,
  });

  // Stable join to avoid re-running when the array identity changes
  // but content stays the same (happens on every render).
  const key = hotkeys.join(',');

  useEffect(() => {
    let cancelled = false;
    async function resolve(): Promise<void> {
      setState((s) => ({ ...s, loading: true, error: null }));
      try {
        const api = await getApi();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const subtensor: any = (api.query as any).subtensorModule;
        if (!subtensor?.owner || !subtensor?.identitiesV2) {
          throw new Error(
            'This chain does not expose SubtensorModule.owner / identitiesV2',
          );
        }

        const entries: Array<[string, VoterIdentity]> = await Promise.all(
          hotkeys.map(async (hotkey) => {
            let coldkey: string | null = null;
            try {
              const raw = await subtensor.owner(hotkey);
              const s = raw?.toString ? raw.toString() : String(raw);
              // The storage map's default value for absent entries is
              // all-zero bytes, which SS58-encodes to ZERO_ACCOUNT.
              // That's "no owner", not a real coldkey — null it out
              // so the UI doesn't display a misleading address.
              coldkey = s && s !== ZERO_ACCOUNT ? s : null;
            } catch {
              coldkey = null;
            }

            // identitiesV2 is keyed on the coldkey, not the hotkey.
            // If we don't have a coldkey (hotkey never registered on
            // Subtensor), there's no identity to look up.
            let name: string | null = null;
            if (coldkey) {
              try {
                const raw = await subtensor.identitiesV2(coldkey);
                name = extractName(raw);
              } catch {
                name = null;
              }
            }
            return [hotkey, { coldkey, name }] as [string, VoterIdentity];
          }),
        );

        if (cancelled) return;
        setState({
          byHotkey: new Map(entries),
          loading: false,
          error: null,
        });
      } catch (e) {
        if (cancelled) return;
        setState({
          byHotkey: new Map(),
          loading: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    void resolve();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return state;
}
