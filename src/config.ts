export const GITHUB_OWNER = 'evgeny-s';
export const GITHUB_REPO = 'anonym-vote';
export const GITHUB_BRANCH = 'main';

export const TOKEN = import.meta.env.VITE_TOKEN ?? '';

// TODO: Add senate wallets
export const ALLOWED_VOTERS = [
  '5FTU22ZFWmzYWqCk5hJTyjq4W7VP3MTzJ1RB4NPec1h8sYCP',
  '5FU9u1fGX5x2XgR5FZpkawZ4dXy7oLbQj8SxHdtydzWtyMXm',
  '5H3DTzx9gQnqio9ixjxLtr7MyjzLrx5ZgRWDEsxgBELN4TJP',
  '5Ff9wuYWk2r8qKutC5NKGBqEVY2rty5JXCBTXz5Tm7ndiWwQ',
  '5HGjWAeFDfFCWPsjFQdVV2Msvz2XtMktvgocEZ5GPjGNRdnW',
  '5CiPPseXPECbkjWCa6MnjNokrgYjMqmKndv2rSnekmSK2DjL',
  '5GNJqTPyNqANBkUVMN1LPPrxXnFouWXoe2wNSmmEoLctxiZY',
  '5HpG9w8EBLe5XCrbczpwkiuqqeCJAFmFBeMHgHVAHMTBDdR9',
  '5Ck5SLSHYac6WFt5UZRSsdJjwmpSZq85fd5TRNAdZQVzEAPT',
  '5DyN7T31UjpYh6Gx4R2bDWBz6yxkxwzgC4aD7sHJVYY1vU3',
  '5GYkKHCt3rJH4MsBcJhpFagSi6DLq4mQTsNy7gHqpWq3gBzY',
  '5EYCAe5XG5xCxmTbZhkZHFgFr1kyD1RWMM2jSDFzqfCJz9Ve',
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
