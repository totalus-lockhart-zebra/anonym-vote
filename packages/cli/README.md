# @anon-vote/cli

CLI for auditors and voters. Three commands: **verify** (independent
tally), **announce** (register your voting key), and **vote** (cast a
ring-signed vote).

The faucet's `/faucet/info` endpoint is the source of truth for
proposal metadata — `proposalId`, `startBlock`, `allowedVoters`,
`coordinatorAddress`. `verify` and `vote` both pull from there by
default; explicit `--proposal`, `--start-block`, `--allowed`,
`--coordinator` flags exist as overrides (useful for replaying a
historical snapshot or auditing against a hypothetical config).

All three commands pin the chain identity via `--expected-genesis`
and refuse to run if the RPC reports a different genesis hash.

## Build

```sh
# repo root
npm run wasm:build      # Rust → WASM (pkg/ is gitignored)
npm run shared:build    # shared types/functions
npm run cli:build       # TypeScript → dist/
```

Or the aggregate: `npm run build`.

## verify

Independent auditor tally. Scans the chain, reconstructs the ring,
verifies every ring signature via the same WASM crate the backend
faucet uses, and prints the tally plus a deterministic `sha256:…`
hash over the outcome — two independent runs produce the same hash.

```sh
node packages/cli/dist/index.js verify \
  --ws wss://dev.chain.opentensor.ai:443 \
  --expected-genesis 0x077899043eb684c5277b6814a39161f4ce072b45e782e12c81a521c63fb4f3e5 \
  --faucet-url https://faucet.example.com
```

Optional flags:

- `--proposal <id>` — override faucet's proposalId (errors out if they disagree).
- `--start-block <n>` — override scan floor.
- `--allowed <csv>` — override allowlist.
- `--coordinator <addr>` — override coordinator address.
- `--to-block <n>` — freeze the upper bound (for reproducing historical
  snapshots). Defaults to chain head at scan time.
- `--concurrency <n>` — parallel block fetches (default 16).
- `--json` — machine-readable output.

## announce

Generates a voting key for your wallet (or re-uses the stored one) and
publishes the announce remark signed by the real wallet. Run this once
per proposal per real wallet, before voting opens.

```sh
node packages/cli/dist/index.js announce \
  --ws wss://dev.chain.opentensor.ai:443 \
  --expected-genesis 0x077899043eb684c5277b6814a39161f4ce072b45e782e12c81a521c63fb4f3e5 \
  --proposal proposal-1 \
  --mnemonic "twelve word bip39 phrase here ..."
```

Or with a Polkadot-JS keystore export:

```sh
node packages/cli/dist/index.js announce \
  --ws ... --expected-genesis ... --proposal proposal-1 \
  --json-file ./my-export.json --password '...'
```

The voting key (`sk`+`pk`) is written to
`~/.anon-vote/<proposalId>/<address>.voting-key.json` with 0600
perms. Override the directory with `--key-dir <path>`.

## vote

Announce must already be on chain (either via `announce` or via the
UI). The command:

1. Pulls `proposalId`, `startBlock`, `allowedVoters` from
   `/faucet/info`.
2. Scans remarks from `startBlock` to head and reconstructs the
   canonical ring. Refuses if your VK isn't in it.
3. Ring-signs a drip message, POSTs to the faucet, waits for gas.
4. Ring-signs the vote at the same ring block, encodes, and
   publishes the vote remark via a one-shot gas wallet — the
   extrinsic signer is not your real address, which is where the
   anonymity comes from.

```sh
node packages/cli/dist/index.js vote \
  --ws wss://dev.chain.opentensor.ai:443 \
  --expected-genesis 0x077899043eb684c5277b6814a39161f4ce072b45e782e12c81a521c63fb4f3e5 \
  --faucet-url https://faucet.example.com \
  --choice yes \
  --mnemonic "..."
```

Optional flags: `--proposal`, `--start-block`, `--allowed` (same
overrides as `verify`), `--gas-timeout <ms>`, `--key-dir <path>`.

The gas wallet mnemonic is persisted at
`~/.anon-vote/<proposalId>/<address>.gas-wallet.json` (0600 perms).
If drip/wait/publish is interrupted, re-running the command resumes
against the same gas address instead of asking for a second drip.

## Wallet input

All commands that sign extrinsics (`announce`, `vote`) accept three
shapes. Pick one:

1. **Raw mnemonic** — `--mnemonic <phrase>` or env `MNEMONIC`.
2. **Polkadot-JS keystore** (encrypted) — `--json-file <path>` plus
   `--password <pw>` or env `JSON_PASSWORD`.
3. **SDK key export** (plain JSON with a `secretPhrase` field, as
   produced by `py-substrate-interface`, `subkey inspect --json`,
   etc.) — `--json-file <path>`, no password needed. The loader
   detects the `secretPhrase` field and uses it as the mnemonic;
   other fields in the file are ignored.

The env-var fallbacks make it easy to avoid leaking secrets into
shell history.

## Exit codes

- `0` — success (clean tally / announce on chain / vote on chain)
- `1` — `verify` found invalid votes or no coordinator start-remark
- `2` — fatal (genesis mismatch, RPC failure, wrong password, faucet
  unreachable, bad args)

## Keystore layout

```
~/.anon-vote/
└── <proposalId>/
    ├── <address>.voting-key.json    # { sk, pk, createdAt }
    └── <address>.gas-wallet.json    # { mnemonic, createdAt }
```

Both files are written with 0600 perms — read access = full ability
to cast a vote in the voter's slot (once) or drain the gas wallet.
Back them up the same way you'd back up any other key material.
