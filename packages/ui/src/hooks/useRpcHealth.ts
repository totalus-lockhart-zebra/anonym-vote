/**
 * RPC health hook — resolves the current ApiPromise and checks its
 * genesis hash against the expected one, so the UI can warn the user
 * when the configured RPC endpoint points at the wrong chain.
 */

import { useEffect, useState } from 'react';
import { checkGenesis } from '../subtensor';
import { EXPECTED_GENESIS_HASH, SUBTENSOR_WS } from '../config';

export type RpcStatus = 'connecting' | 'ok' | 'mismatch' | 'error';

export interface RpcHealth {
  status: RpcStatus;
  wsUrl: string;
  expectedGenesis: string;
  actualGenesis: string | null;
  error: string | null;
}

export function useRpcHealth(): RpcHealth {
  const [state, setState] = useState<RpcHealth>({
    status: 'connecting',
    wsUrl: SUBTENSOR_WS,
    expectedGenesis: EXPECTED_GENESIS_HASH,
    actualGenesis: null,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    checkGenesis()
      .then(({ ok, actual }) => {
        if (cancelled) return;
        setState((s) => ({
          ...s,
          status: ok ? 'ok' : 'mismatch',
          actualGenesis: actual,
        }));
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setState((s) => ({
          ...s,
          status: 'error',
          error: e instanceof Error ? e.message : String(e),
        }));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
