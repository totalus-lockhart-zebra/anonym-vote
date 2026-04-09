export const GITHUB_OWNER = 'evgeny-s';
export const GITHUB_REPO = 'anonym-vote';
export const GITHUB_BRANCH = 'main';

const partsJson = JSON.parse(import.meta.env.VITE_PARTS_JSON) ?? '';
export const PARTS = partsJson.map(atob).join('_');

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
];

export const ACTIVE_PROPOSAL = {
  id: 'proposal-1',
  title: 'Release to Mainnet (Week of Apr 13)',
  description: `Features to be releases: <br>
                   1. Lock cost based Liquidity Injection on New Subnet Registration. <br>
                   2. Auto Child hotkeys`,
  deadline: '2026-04-15T12:00:00Z',
  quorum: 7,
};
