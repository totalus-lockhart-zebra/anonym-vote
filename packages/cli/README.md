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

From the repo root:

```sh
npm run build
```

That runs every step in order: `wasm:build` (Rust→WASM via wasm-pack,
required because `packages/ring-sig/wasm/pkg/` is gitignored),
`shared:build`, `api:build`, `ui:build`, `cli:build`.

If you only need the CLI and already have the wasm artifacts:

```sh
npm run wasm:build   # skip if packages/ring-sig/wasm/pkg/*.wasm exists
npm run shared:build
npm run cli:build
```

First run needs Rust + wasm-pack installed; the `wasm:build` step
installs them via `scripts/heroku-prebuild.sh` if missing (~1 min
cached, 3-5 min cold).

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

## Docker

A multi-stage Dockerfile builds the CLI into a slim `node:22-slim`
image. `docker-compose.yml` defines three services: **verify**,
**announce**, and **vote**.

### Build

```sh
docker compose build verify   # builds the shared image (all services use it)
```

### Usage

```sh
# Verify — read-only tally audit
docker compose run --rm verify

# Announce — register voting key (requires wallet file)
WALLET_PATH=/path/to/hotkey.json docker compose run --rm announce

# Vote — cast a ring-signed vote (CHOICE is required)
CHOICE=yes  WALLET_PATH=/path/to/hotkey.json docker compose run --rm vote
CHOICE=no   WALLET_PATH=/path/to/hotkey.json docker compose run --rm vote
```

### Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `WS_URL` | no | `wss://archive-rocksdb.internal.tao.com` | Subtensor WebSocket RPC (must be an archive node) |
| `EXPECTED_GENESIS` | no | `0x2f0555cc…` (Finney) | Pinned genesis hash — CLI refuses to run on a different chain |
| `PROPOSAL_ID` | no | `proposal-1` | Proposal identifier |
| `FAUCET_URL` | no | `https://api-vote.tao.com` | Faucet base URL (source of truth for allowlist, coordinator, startBlock) |
| `WALLET_PATH` | **yes** (announce, vote) | — | Host path to a wallet keystore JSON file (mounted read-only at `/wallet`) |
| `CHOICE` | **yes** (vote) | — | `yes`, `no`, or `abstain`. No default — prevents accidental votes |

### Volume: `keys`

The `announce` and `vote` services share a named Docker volume
(`keys`) mounted at `/home/anon/.anon-vote`. This volume holds:

- `<proposalId>/<address>.voting-key.json` — BLSAG secret key + public
  key. **Plaintext.** Anyone with read access can forge a vote in
  this voter's slot.
- `<proposalId>/<address>.gas-wallet.json` — sr25519 mnemonic for the
  one-shot gas wallet. **Plaintext.** Anyone with read access can
  drain the gas balance.

The volume persists across container runs so `announce` and `vote`
can be invoked separately. To wipe secrets after voting:

```sh
docker volume rm anonym-vote_keys
```

### Security hardening

The compose file applies:
- `read_only: true` (verify service)
- `cap_drop: ALL` — no Linux capabilities
- `no-new-privileges` — no setuid escalation
- `tmpfs /tmp` with `noexec,nosuid`
- Memory limit 512 MB, CPU limit 1 core
- Wallet file mounted `:ro` (read-only)
- Non-root user (`anon:1001`)

### WALLET_PATH format

`WALLET_PATH` must point to a **file**, not a directory. Accepted
formats:

1. **Polkadot-JS keystore** (encrypted JSON) — set `JSON_PASSWORD`
   env var or pass `--password` after `--`.
2. **SDK key export** (plain JSON with a `secretPhrase` field) — no
   password needed. This is the format produced by `btcli`,
   `subkey inspect --json`, and `py-substrate-interface`.
