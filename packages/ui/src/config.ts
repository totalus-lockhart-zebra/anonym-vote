export const SUBTENSOR_WS =
  (import.meta.env.VITE_SUBTENSOR_WS as string | undefined) ??
  'wss://dev.chain.opentensor.ai:443';

export const FAUCET_URL =
  (import.meta.env.VITE_FAUCET_URL as string | undefined) ??
  'http://localhost:3000';
