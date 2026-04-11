# TaoVoter

Anonymous, verifiable voting for a fixed set of eligible Polkadot
accounts. Votes are published as `system.remark` extrinsics on a
Subtensor (Bittensor) chain. The on-chain data is enough for anyone
to count the result, but **no observer — including the faucet
operator — can link a published vote back to the real voter who cast
it**.

This repository is a monorepo of four workspace packages:

| Package              | Stack                     | Purpose                                                                |
| -------------------- | ------------------------- | ---------------------------------------------------------------------- |
| `packages/shared`    | Plain TypeScript          | Wire format, parsers, ring reconstruction, tally — shared by UI + API. |
| `packages/ring-sig`  | Rust + wasm-pack          | Vendored BLSAG ring signatures over Ristretto255; CLI + WASM targets.  |
| `packages/api`       | NestJS, @polkadot/api     | Trust-minimized faucet. One endpoint: ring-sig-authenticated `/drip`.  |
| `packages/ui`        | React + Vite              | Voter-facing app. Announces, ring-signs, publishes, scans, tallies.    |

---

## 1. Why this exists

A naive on-chain vote leaks two things:

1. **Who voted.** Every transaction has a signer.
2. **What they voted.** The choice is encoded in the call data.

For a small committee where members need plausible deniability about
how they voted (legal liability, peer pressure, retaliation), both
must be hidden. Specifically:

- **Privacy.** No party — not the chain, not the faucet operator, not
  other voters — may learn the mapping from a real voter to a vote
  choice. Not now, not after the deadline, not ever.
- **Eligibility.** Only the predefined set of allowed voters may vote.
- **No double voting.** Each eligible voter contributes at most one
  counted ballot.
- **Public verifiability.** Anyone with a chain RPC can independently
  recompute the tally and check every counted vote came from an
  eligible voter.
- **No trusted storage.** The chain is the only source of truth. No
  database, no Git repository, no off-chain JSON files.

An earlier iteration of this project used a coordinator that issued
signed eligibility credentials over a per-voter nullifier. That
design worked but it required trusting a single operator not to log
the `(real, stealth)` pair it saw during each credential issuance —
if the operator was dishonest (or just negligent about logs), every
vote could be de-anonymized after the fact. The current design
removes the coordinator entirely: eligibility is proved by a linkable
ring signature over public keys the voters themselves publish on
chain, and the only remaining server-side component (the faucet) is
a convenience that cannot learn which voter it is funding.

---

## 2. Cryptographic design

### 2.1 Actors

```
┌────────────┐                           ┌──────────────────┐
│  Voter     │   RPC (system.remark)     │  Subtensor       │
│  (browser) │ ─────────────────────────►│  (Finney / test) │
│            │                           │                  │
└─────┬──────┘                           └──────────────────┘
      │
      │ HTTPS (ring-sig-authenticated drip request)
      ▼
┌────────────┐
│  Faucet    │
│  (NestJS)  │
└────────────┘
```

There are three kinds of keys in play, each with a tightly scoped
lifetime:

| Key               | Owner      | Lifetime            | Purpose                                                   |
| ----------------- | ---------- | ------------------- | --------------------------------------------------------- |
| **Real wallet**   | Voter      | Long-lived          | Publishes the announce remark that binds a voting key to  |
|                   |            |                     | an allowlist member. Signs nothing else.                  |
| **Voting key**    | Voter      | One proposal        | Ristretto255 scalar. Used only by BLSAG to ring-sign the  |
|                   |            |                     | drip request and the vote. Never signs an extrinsic.      |
| **Gas wallet**    | Voter      | One voting session  | Fresh sr25519, session-scoped. Pays for the `system.remark` |
|                   |            |                     | extrinsic that carries the vote payload. No other role.   |

The **real wallet** appears on chain exactly once per voter — during
the announce window — publishing the voting key's public half. The
**voting key** never appears on chain except as its public half in
that announce remark. The **gas wallet** appears on chain as the
signer of the vote extrinsic, and nothing links it back to either of
the other two.

### 2.2 The single non-obvious primitive: BLSAG ring signatures

Instead of signing a vote with a credential handed out by a
coordinator, each voter signs the vote with a **ring signature** over
the set of announced voting keys. The signature proves:

> "Some member of this ring authorized this message."

It does **not** reveal which member. And the signature carries a
**key image** — a deterministic function of the signer's secret key
— which acts as a one-time nullifier: two signatures with the same
key image provably came from the same secret key, but the key image
is cryptographically unlinkable to the public key behind it.

We vendor the BLSAG implementation from
[`opentensor/subtensor`](https://github.com/opentensor/subtensor/blob/52123921e60cada845dcd2b34eee537aff596bc9/primitives/crypto/src/lib.rs)
at a pinned commit; the exact provenance and local modifications are
documented in
[`packages/ring-sig/vendored/blsag/PINNED_COMMIT.md`](packages/ring-sig/vendored/blsag/PINNED_COMMIT.md).
The Rust crate is compiled to two wasm-pack targets: `bundler` for
the Vite-built browser UI, `nodejs` for the NestJS faucet. Both
consume the same vendored source, so the sign/verify code path is
byte-identical on both sides.

### 2.3 Protocol flow

The proposal has **two phases**, separated by a coordinator-
published `start` remark:

```
blocks:  startBlock                       Coordinator's start remark
         ├──────────────────────────────┤────────────────────────────►
phase:           announce                          voting
                 (Register)                     (Yes/No/Abstain)
```

- **Announce phase** runs from `startBlock` until the
  coordinator publishes a `system.remark("anon-vote-v2:start:<id>")`
  from the configured coordinator address. During this window
  voters publish their voting public keys (signed by their real
  wallet) but **cannot vote**. The UI shows only the "Register"
  button.

- **Voting phase** opens the moment the coordinator's start
  remark lands in a block. After this, registered voters can
  ring-sign their choice and publish the vote remark via a
  throwaway gas wallet (zero extension popups for already-
  registered voters). The voting window never closes — late
  voters can come back days later and the tally keeps updating.

**Why two phases**: this is the central defense against on-chain
**timing-correlation**. In a one-phase ("lazy announce") flow, a
voter publishes their announce and their vote within ~30 seconds
of each other in the same browser session. An observer watching
the chain in real time can pair them by temporal proximity even
without breaking the ring signature math. The two-phase model
breaks this: announces concentrate in one window (hours/days
before voting opens) and votes concentrate in another (after
the coordinator opens it). The temporal gap between any
individual voter's announce and their vote is now hours/days
instead of seconds, so the announce-vote pairing is destroyed
in the noise of all the other announces in the announce window.

**The coordinator's only protocol power** is "decide WHEN
voting opens". They cannot affect WHO votes (allowlist + ring),
WHAT (the choices), or count anything (tally is local).
Operationally: the coordinator is just one of the senate
members holding a known wallet, and "publishing the start
remark" is the modern equivalent of the chair calling the vote
to order.

**The single non-trivial cryptographic concept** is **ringBlock**:
every vote embeds the chain block number at which the voter
computed the canonical ring before signing. Verifiers
reconstruct the ring at exactly that block when checking the
signature. This lets early voters sign against a smaller ring
than later voters and have both verify correctly forever.

**Voter session in announce phase** (Register, one extension popup):
1. Browser generates a Ristretto255 voting keypair (VKsk/VKpub).
2. Browser asks the polkadot.js extension to sign and publish
   `system.remark("anon-vote-v2:announce:<id>:<VKpub>")` from
   the voter's real wallet.
3. Browser waits until the local indexer observes the announce.
4. UI shows "✓ Registered. Waiting for coordinator to open
   voting…". The voter can close the tab.

**Voter session in voting phase** (Yes/No/Abstain, zero extension popups):
1. Browser already has VKsk in localStorage from the announce
   phase, plus the corresponding announce already on chain.
2. Voter clicks a choice.
3. Browser generates a fresh sr25519 gas wallet locally.
4. Browser ring-signs `drip:<id>:<gasAddress>:<ringBlock>` with
   VKsk against the ring at `ringBlock`.
5. Browser POSTs the ring sig to `/faucet/drip`. Faucet
   reconstructs the ring at the same `ringBlock`, verifies, and
   sends TAO to the gas address.
6. Browser waits for the gas balance to land.
7. Browser ring-signs `vote:<id>:<choice>:<ringBlock>` with the
   same VKsk (same key image, different message).
8. Browser submits `system.remark(vote payload)` signed by the
   gas wallet. Done.

**Late voter** (didn't register in the announce window): clicks
a choice in the voting phase, UI invisibly does step 1-4 of the
announce session followed by step 3-8 of the voting session in
one shot. Works, but their announce and vote are temporally
adjacent — a chain observer can pair them by timing. We don't
warn the voter; the only mitigation is "register on time".

### 2.4 Messages

Two messages are signed by the voter's ring key. Each binds the
proposal id, the relevant per-action data, AND the ringBlock the
voter signed against. Embedding ringBlock in the signed bytes is
what lets the faucet and the tally know exactly which ring
snapshot to reconstruct.

```
drip message:  "drip:<proposalId>:<gasAddress>:<ringBlock>"   (utf-8)
vote message:  "vote:<proposalId>:<choice>:<ringBlock>"        (utf-8)
```

Both share the **same** key image (BLSAG key images are a function
of the secret key only). That is the mechanism by which the faucet
dedup and the tally dedup end up on the same value — they are
observing the same nullifier.

### 2.5 On-chain payloads

Two kinds of `system.remark` carry proposal-related data:

**Announce remark** — plain text, signed by the voter's REAL wallet:
```
anon-vote-v2:announce:<proposalId>:<vkPubHex>
```

**Vote remark** — JSON, signed on-chain by the voter's GAS wallet:
```json
{
  "v":  2,
  "p":  "<proposalId>",
  "c":  "yes" | "no" | "abstain",
  "rb": <ringBlock>,
  "sig": {
    "challenge":  "<64 hex>",
    "responses":  ["<64 hex>", ...],
    "key_image":  "<64 hex>"
  }
}
```

`rb` (ring block) is the chain block at which the voter
reconstructed the ring before signing. Verifiers reconstruct
the ring at exactly this block to check the signature.

Every field in every remark is either literal text or hex, so any
observer can grep the chain with `system.remark` filters and round
the data through `ring-cli verify` to re-check a vote off-chain.

### 2.6 What every observer sees, and what they can't

| Observer can see                                              | Observer cannot see                                      |
| ------------------------------------------------------------- | -------------------------------------------------------- |
| The set of real addresses that announced a voting key         | Which voting key belongs to which allowlisted voter... |
| The canonical ring (same for everyone)                        | ...at the *ring signature* level. BLSAG hides the signer. |
| The vote remarks, including choice and key image              | Which ring member signed a given vote remark             |
| The extrinsic signer of a vote remark (a throwaway gas address) | The voter behind that gas address                       |
| Pairs of key images that match (same signer voted twice)      | The voting key a key image came from                    |
| The total count of valid votes per choice                     | A link from any voter to any choice                      |

The last row is the load-bearing one. BLSAG's anonymity guarantee is
standard: given the ring and a signature, the best an adversary can
do is a uniform guess among the ring members. The key image is
`k * H_p(K)` on Ristretto255, which is cryptographically
indistinguishable from random without the secret `k`.

### 2.7 Why this satisfies every requirement

| Requirement                                             | How it's enforced                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Only eligible voters may vote                           | The ring is built from allowlist-signed announces. A ring sig proves ring membership. |
| Each eligible voter votes at most once                  | Tally drops second-and-later remarks with the same key image.                  |
| No observer can link a real voter to a choice           | Ring signatures hide the signer; key images are unlinkable to their public keys; the on-chain extrinsic signer is a throwaway gas address. |
| No cross-proposal vote correlation                      | Each proposal uses a fresh `startBlock` and the voter generates a fresh VK per proposal. Different VKs ⇒ different key images ⇒ no profile linking across proposals. |
| Result is publicly verifiable                           | Anyone with a chain RPC can recompute the ring at any block, verify every ring sig, and tally. No server involvement needed. |
| No trusted off-chain storage                            | The chain is the only persistent store. The faucet is stateless across restarts for anything security-relevant. |
| Late voters welcome                                     | No vote end block. Ring grows monotonically. Each vote embeds its own ringBlock so old and new votes verify against their own snapshots. |

### 2.8 Trust model and known limits

**What you have to trust:**

- **The vendored BLSAG crate**. This is a non-upstreamed primitive
  from `opentensor/subtensor`. It is well-commented, well-tested (35
  upstream tests, all green in our vendored copy), and derived from
  a standard construction (Back's Linkable Spontaneous Anonymous
  Group, "Zero to Monero" §3.4), but it has not been externally
  audited. Anyone running this for real should review the
  pinned source.
- **Your own browser not being compromised**. Voting keys and gas
  wallets live in localStorage (plain text). A malicious browser
  extension can read them. An encrypted-localStorage upgrade is
  tracked as a future improvement.

**What you do NOT have to trust:**

- **The chain operator**. The chain is a public bulletin board.
- **Other voters**. They can publish anything they like in remarks;
  only remarks with a valid ring signature over the canonical ring
  and a fresh key image are counted.
- **The faucet operator's intent**. The faucet can refuse service
  (censor) and can log request metadata. Neither breaks anonymity:
  the drip request carries only a ring signature and a fresh gas
  address, neither of which is linkable to the real voter.
- **The faucet's correctness in the past**. The faucet is a
  transfer-only service; anyone can double-check a drip tx on chain.

**Known residual risks:**

- **Censorship via the faucet.** If the only running faucet refuses
  to issue a drip, the voter cannot pay gas automatically. The UI
  falls back to a manual-funding path: generate the gas wallet,
  display its address, let the voter send TAO by hand. Anyone with
  TAO can fund the gas wallet; the rest of the flow works unchanged.

- **Timing correlation at the faucet.** If the faucet operator
  records the IP address of each `/drip` request and also records
  the block number of the subsequent vote remark, they can infer
  `(IP → vote remark)`, and from there `(IP → choice)`. The ring
  signature still hides *which ring member* voted, so this does not
  leak a real voter identity — but it does link a network-level
  observation to a choice. Operational mitigation: run the faucet
  behind a reverse proxy with no `access_log`, or use Tor / VPN.

- **Early voter has a small ring**. Because the ring grows
  monotonically with each new announce, the first voter has a
  ring of 2 (themselves plus whoever announced first), the
  second has 3, etc. The very first voter is identifiable: with
  ring size 2, observers guess them with 50% accuracy. Mitigation
  is operational — voters in a senate of 12 can voluntarily wait
  for a few announces to land before clicking. The UI shows the
  current ring size before the click. Math: the average
  anonymity for a voter joining at position k of N total voters
  is 1/k; averaged over the whole proposal it's
  approximately `(N+1)/(2N)` ≈ 0.54 for N=12, meaning the
  *typical* voter sits in a ring of ~6-7 members.

- **Lost voting key**. If a voter clears their browser storage
  for this proposal between announce and vote, the voting key
  secret half is gone. Their announce-remark stays on chain (now
  inert) and they can no longer vote in this proposal. They can
  re-announce a fresh key from a new browser session — the new
  key replaces the old one in the ring (latest-wins per real
  address). The previous key's announce becomes orphaned but
  causes no other harm.

- **Participation is leaked in the announce step**. Observers see
  which allowlist members announced a voting key. They cannot see
  *how* a voter voted, but they do see *whether*. Hiding
  participation as well would require a different primitive
  (mixnet or stealth-registration) and is explicitly out of scope.

---

## 3. End-to-end interaction

### 3.1 Voting (single-session flow)

```
┌────────┐         ┌────────┐         ┌──────────┐
│ Voter  │         │ Faucet │         │  Chain   │
│        │         │        │         │          │
└───┬────┘         └───┬────┘         └────┬─────┘
    │                   │                    │
    │ 1. Click choice in UI                  │
    │                                        │
    │ 2. Generate VK keypair locally,        │
    │    sk → localStorage                   │
    │                                        │
    │ 3. Real wallet signs and publishes     │
    │    "anon-vote-v2:announce:<id>:<vk>"   │
    │ ──────────────────────────────────────►│
    │                                        │ [block A]
    │                                        │
    │ 4. Wait for local indexer to observe   │
    │    the announce                        │
    │                                        │
    │ 5. Generate fresh gas sr25519,         │
    │    mnemonic → localStorage             │
    │                                        │
    │ 6. Pick ringBlock = current head.      │
    │    Compute ring at this block from     │
    │    on-chain announces.                 │
    │                                        │
    │ 7. Ring-sign                           │
    │    "drip:<id>:<gas>:<rb>" with VKsk    │
    │                                        │
    │ 8. POST /faucet/drip                   │
    │    { proposalId, gasAddress,           │
    │      ringBlock, ringSig }              │
    │ ──────────────►│                       │
    │                │ recompute ring at rb  │
    │                │ verify ringSig        │
    │                │ key image not seen ok │
    │                │ transferKeepAlive(gas)│
    │                │ ──────────────────────►│
    │                │                        │ [block B]
    │                │                        │
    │ 9. Poll gas balance until funded       │
    │                                        │
    │ 10. Ring-sign                          │
    │     "vote:<id>:<choice>:<rb>" with     │
    │     same VKsk (same key image,         │
    │     different message)                 │
    │                                        │
    │ 11. encodeVoteRemark → JSON            │
    │                                        │
    │ 12. system.remark(payload), signed     │
    │     by the GAS wallet                  │
    │ ──────────────────────────────────────►│
    │                                        │ [block C]
    │                                        │
    │ ✓ done                                 │
```

Steps 1-12 happen in a single browser session. Step 3 is the
only one that requires a wallet extension popup; from the
voter's POV: open UI → click choice → approve in extension →
wait ~30 seconds → done.

For a returning voter on a NEW proposal, the same 12 steps run
again with a fresh VK (per-proposal isolation). For a returning
voter on the SAME proposal (e.g. they refreshed mid-flow),
steps 1-4 are skipped because the announce is already on chain
and the VK is already in localStorage.

### 3.2 Counting

```
┌──────────┐                                    ┌──────────┐
│ Anyone   │                                    │  Chain   │
│ (UI)     │                                    │          │
└────┬─────┘                                    └────┬─────┘
     │                                                │
     │ 1. Subscribe to chain head.                    │
     │ 2. Scan blocks [startBlock .. head] for        │
     │    system.remark extrinsics.                   │
     │ ──────────────────────────────────────────────►
     │                                                │
     │ 3. For each vote remark:                       │
     │      parse JSON, read `rb` (ringBlock)         │
     │      reconstruct ring at block `rb` from       │
     │        announces in [startBlock..rb]           │
     │      verify ring sig against that ring         │
     │      drop duplicates by key_image              │
     │    aggregate yes / no / abstain.               │
```

The crucial property: the ring is reconstructed PER VOTE at the
block embedded in the vote payload. Early voters used a smaller
ring; later voters used a bigger ring; both verify forever.

Counting is purely a function of `(chain state, pinned ring-sig
crate)`. The faucet plays no role; it could disappear after the
last drip and every browser would still arrive at the same tally
minutes later.

---

## 4. Configuration

### Faucet (`packages/api/.env`)

Environment variables. See `.env.example` for the full list.

- `SUBTENSOR_WS` — WebSocket RPC of the target chain.
- `FAUCET_MNEMONIC` — sr25519 mnemonic for the faucet wallet.
  Must be pre-funded with `FUND_AMOUNT_RAO * allowedVoters.length`
  TAO plus a margin for the faucet's own gas.
- `PROPOSAL_ID` — string identifier. Must match `proposal.ts` in
  the UI.
- `PROPOSAL_START_BLOCK` — first block the ring indexer scans.
  Per-proposal isolation comes from setting a fresh value here
  for each new proposal.
- `ALLOWED_VOTERS` — comma-separated SS58 addresses. Must match
  the UI.
- `FUND_AMOUNT_RAO` — amount transferred per drip.

### UI (`packages/ui/src/proposal.ts`)

The UI has no runtime configuration — the whole point of the
design is that the UI is a static site that does not trust any
server. The proposal definition lives in `packages/ui/src/proposal.ts`
as a git-tracked constant:

```ts
export const PROPOSAL: ProposalConfig = {
  id: 'proposal-1',
  title: '…',
  description: '…',
  allowedVoters: ['5Cs…', '5D4…', …],
  startBlock: 123456,
  coordinatorAddress: '5XYZ…',
};
```

The `TODO(operator)` comments in that file call out what to fill
in before shipping. The allowlist and start block MUST match the
faucet's env vars byte-for-byte, otherwise ring reconstruction
diverges and every drip verification fails. The
`coordinatorAddress` is the SS58 of the wallet that will publish
the `start` remark when the senate is ready to open voting; the
UI watches for this remark and flips from announce phase to
voting phase the moment it lands.

When you want to start a NEW proposal: change `id`, update
`title` and `description`, set `startBlock` to the current chain
head (so old announces from the previous proposal don't bleed
in), and decide who the coordinator is (usually the same wallet
across proposals; you can change it per proposal too). Voters
generate fresh VKs for each new proposal automatically — there
is no cross-proposal key reuse.

**Opening voting**: when the announce window has been open long
enough for the senate to register, the coordinator publishes the
start remark by submitting one extrinsic from their wallet:
```
system.remark("anon-vote-v2:start:proposal-1")
```
This can be done from polkadot.js apps, the Subtensor CLI, or
any tool that can sign a system.remark from the coordinator's
account. The UI in every voter's browser sees the new remark on
the next subscription tick and immediately flips to voting
phase.

The UI does accept two runtime env vars (via Vite):

- `VITE_SUBTENSOR_WS` — RPC endpoint, defaults to the Finney testnet.
- `VITE_FAUCET_URL` — faucet base URL, defaults to
  `http://localhost:3000`.

---

## 5. Running locally

### Prerequisites

- Node 22+ (npm workspaces)
- Rust toolchain (stable) + [`wasm-pack`](https://rustwasm.github.io/wasm-pack/)
- A pre-funded sr25519 account on the target chain to use as the
  faucet wallet

### One-time build of the ring-sig wasm targets

```
# Bundler target (consumed by the UI)
wasm-pack build packages/ring-sig/wasm --target bundler --out-dir pkg-bundler --release

# Node target (consumed by the faucet)
wasm-pack build packages/ring-sig/wasm --target nodejs --out-dir pkg --release
```

You need to re-run these two commands whenever you change the
vendored BLSAG source. The other packages consume the generated
`pkg/` and `pkg-bundler/` directories directly via file-path
workspace dependencies.

### Install + build the JS workspaces

```
npm install             # install all workspaces, symlink @anon-vote/shared
npm run build           # builds shared → api → ui in order
```

### Configure the faucet

```
cp packages/api/.env.example packages/api/.env
$EDITOR packages/api/.env
```

Fill in:
- `FAUCET_MNEMONIC`
- `PROPOSAL_ID` and `PROPOSAL_START_BLOCK` (must match
  `packages/ui/src/proposal.ts`)
- `ALLOWED_VOTERS` (same)

### Configure the UI

Edit `packages/ui/src/proposal.ts` and fill in the
`TODO(operator)` fields: `allowedVoters` and `startBlock`.

### Run

```
npm run dev             # starts faucet (port 3000) + UI (port 5173) concurrently
```

or separately:

```
npm run api:dev
npm run ui:dev
```

### Verify off-chain

To manually verify a vote remark without trusting the browser
WASM build, use the CLI:

```
cargo run -p ring-cli -- verify \
  --ring    /path/to/ring.json \
  --msg     /path/to/vote-message.bin \
  --sig     /path/to/signature.json
```

`ring-cli` reads the same JSON formats the UI produces, so you can
copy-paste any on-chain vote payload straight into a verification
command.

---

## 6. Tests

```
npm test                # runs shared build + all workspace tests
```

- `packages/shared` — currently exercised by the UI test suite
  (`packages/ui/src/shared.test.ts`, 27 tests covering announce and
  vote remark encode/parse, ring reconstruction edge cases, tally
  semantics, and end-to-end BLSAG signing/verification).
- `packages/ui` — `phase.test.ts` (6 tests) + `ring-sig.test.ts`
  (bundler WASM path, 2 tests) + `shared.test.ts` above.
- `packages/ring-sig/vendored/blsag` — `cargo test -p stp-crypto`
  runs the 35 upstream BLSAG tests.
- `packages/ring-sig/cli` — `cargo test -p ring-cli` runs two
  integration tests pinning the CLI wire format.
