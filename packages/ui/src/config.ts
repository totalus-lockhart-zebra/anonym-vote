// ─── Subtensor connection ────────────────────────────────────────────────
export const SUBTENSOR_WS =
  (import.meta.env.VITE_SUBTENSOR_WS as string | undefined) ??
  'wss://subtensor-archive.app.minesight.co.uk';

// ─── Faucet / coordinator ────────────────────────────────────────────────
// URL of the backend faucet. Empty string → use local dev stub (no HTTP).
export const FAUCET_URL =
  (import.meta.env.VITE_FAUCET_URL as string | undefined) ?? '';

// Public SS58 key of the coordinator that signs credentials.
// In dev-stub mode this is ignored at runtime and the stub's own key is used.
export const COORD_PUBKEY_SS58 =
  (import.meta.env.VITE_COORD_PUBKEY_SS58 as string | undefined) ?? '';

// ─── Voters ──────────────────────────────────────────────────────────────
// The 12 Polkadot SS58 addresses allowed to vote (sr25519).
export const ALLOWED_VOTERS = [
  '5CsvRJXuR955WojnGMdok1hbhffZyB4N5ocrv82f3p5A2zVp',
  '5D4gEn5S422dTGR5NJJKZ93FNV6hDmfwDPfxFNgcoVnUkZ4f',
  '5DXdHixxtCvoa6GHKs2Jgrdzc61882Ftx1zN2sYFQuwgL1S1',
  '5Dd8gaRNdhm1YP7G1hcB1N842ecAUQmbLjCRLqH5ycaTGrWv',
  '5FxcZraZACr4L78jWkcYe3FHdiwiAUzrKLVtsSwkvFobBKqq',
  '5Fy3MjrdKRvUWSuJa4Yd5dmBYunzKNmXnLcvP22NfaTvhQCY',
  '5G3wMP3g3d775hauwmAZioYFVZYnvw6eY46wkFy8hEWD5KP3',
  '5GKH9FPPnWSUoeeTJp19wVtd84XqFW4pyK2ijV2GsFbhTrP1',
  '5GP7c3fFazW9GXK8Up3qgu2DJBk8inu4aK9TZy3RuoSWVCMi',
  '5Gq2gs4ft5dhhjbHabvVbAhjMCV2RgKmVJKAFCUWiirbRT21',
  '5HK5tp6t2S59DywmHRWPBVJeJ86T61KjurYqeooqj8sREpeN',
  '5HmkM6X1D3W3CuCSPuHhrbYyZNBy2aGAiZy9NczoJmtY25H7',
  '5FTU22ZFWmzYWqCk5hJTyjq4W7VP3MTzJ1RB4NPec1h8sYCP', // TODO: REMOVE
];

// ─── Active proposal ─────────────────────────────────────────────────────
// startBlock fixes the scan window on chain. All remarks for this proposal
// must land in blocks [startBlock .. block at deadline]. Set this to the
// subtensor block height at the time of proposal creation.
export const ACTIVE_PROPOSAL = {
  id: 'proposal-1',
  title: 'Release to Mainnet (Week of Apr 13)',
  description: `Features to be releases: <br>
                   1. Lock cost based Liquidity Injection on New Subnet Registration. <br>
                   2. Auto Child hotkeys`,
  deadline: '2026-04-15T12:00:00Z',
  quorum: 7,
  // TODO: replace with the actual subtensor block height at proposal creation.
  startBlock: 7_932_000,
};
