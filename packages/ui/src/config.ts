export const SUBTENSOR_WS =
  (import.meta.env.VITE_SUBTENSOR_WS as string | undefined) ??
  'wss://test.finney.opentensor.ai:443';

export const FAUCET_URL =
  (import.meta.env.VITE_FAUCET_URL as string | undefined) ??
  'http://localhost:3000';

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
  '5Ff9wuYWk2r8qKutC5NKGBqEVY2rty5JXCBTXz5Tm7ndiWwQ', // TODO: REMOVE
];

export const ACTIVE_PROPOSAL = {
  id: 'proposal-1',
  title: 'Release to Mainnet (Week of Apr 13)',
  description: `Features to be releases: <br>
                   1. Lock cost based Liquidity Injection on New Subnet Registration. <br>
                   2. Auto Child hotkeys`,
  deadline: '2026-04-15T12:00:00Z',
  quorum: 7,
  startBlock: 6_871_590,
};
