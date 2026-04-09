export const GITHUB_OWNER = 'evgeny-s';
export const GITHUB_REPO = 'anon-vote';
export const GITHUB_BRANCH = 'main';

export const GITHUB_TOKEN = import.meta.env.VITE_TOKEN ?? '';

export const ALLOWED_VOTERS = [
  '5FTU22ZFWmzYWqCk5hJTyjq4W7VP3MTzJ1RB4NPec1h8sYCP',
  '5FU9u1fGX5x2XgR5FZpkawZ4dXy7oLbQj8SxHdtydzWtyMXm',
  '5Ff9wuYWk2r8qKutC5NKGBqEVY2rty5JXCBTXz5Tm7ndiWwQ',
];

export const ACTIVE_PROPOSAL = {
  id: 'proposal-1',
  title: 'Release to Mainnet (Week of Apr 13)',
  description: `Features to be releases: <br>
                   1. Lock cost based Liquidity Injection on New Subnet Registration. <br>
                   2. Auto Child hotkeys`,
  deadline: '2026-04-09T12:30:00Z',
  quorum: 2,
};
