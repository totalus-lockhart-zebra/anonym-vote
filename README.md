# AnonVote

Anonymous, verifiable voting for a fixed set of eligible Polkadot accounts.
Votes are published as `system.remark` extrinsics on a Subtensor (Bittensor)
chain. The on-chain data is enough for anyone to count the result, but **no
observer — including the operator — can link a published vote back to the
real voter who cast it**.

This repository is a monorepo of two packages:

| Package          | Stack                  | Purpose                                                                |
| ---------------- | ---------------------- | ---------------------------------------------------------------------- |
| `packages/api`   | NestJS, @polkadot/api  | Faucet / coordinator. Funds stealth addresses and signs credentials.   |
| `packages/ui`    | React + Vite           | Voter-facing app. Publishes remarks, scans the chain, displays tally.  |

---

## 1. Why this exists

A naive on-chain vote leaks two things:

1. **Who voted.** Every transaction has a signer.
2. **What they voted.** The choice is encoded in the call data.

For a small committee where members need plausible deniability about how
they voted (legal liability, peer pressure, retaliation), both must be
hidden. Specifically:

- **Privacy.** No party — not the chain, not the operator, not other voters
  — may learn the mapping from a real voter to a vote choice. Not now, not
  after the deadline, not ever.
- **Eligibility.** Only the predefined set of allowed voters may vote.
- **No double voting.** Each eligible voter contributes at most one counted
  ballot.
- **Public verifiability.** Anyone with a chain RPC can independently
  recompute the tally and check that every counted vote came from an
  eligible voter.
- **No trusted storage.** The chain is the only source of truth. No
  database, no Git repository, no off-chain JSON files.

Earlier iterations tried time-lock encryption (drand `tlock`) over votes
stored in a Git repository. That failed requirement #1: after the deadline
the ciphertext decrypts to `(real_address, choice)`, exposing every voter
forever. The current design hides the link **before** anything reaches the
chain; there is no later moment at which it leaks, because it never existed
on the wire.

---

## 2. Cryptographic design

### 2.1 Actors

```
┌────────────┐         ┌───────────────┐         ┌──────────────────┐
│  Voter     │  HTTPS  │  Faucet /     │  RPC    │  Subtensor       │
│  (browser) │ ──────► │  Coordinator  │ ──────► │  (Finney / test) │
│            │         │  (NestJS)     │         │                  │
└────────────┘         └───────────────┘         └──────────────────┘
       │                                                 ▲
       │                  RPC (system.remark)            │
       └─────────────────────────────────────────────────┘
```

Three independent keypairs are involved:

| Key                | Owner       | Lifetime              | Purpose                                          |
| ------------------ | ----------- | --------------------- | ------------------------------------------------ |
| **Real wallet**    | Voter       | Long-lived            | Proves the voter is on the allowlist.            |
| **Stealth wallet** | Voter       | One browser session   | Signs the on-chain remark. Holds no other state. |
| **Coordinator**    | Faucet host | Long-lived            | Signs eligibility credentials.                   |

The stealth wallet is generated locally in the browser from a fresh sr25519
mnemonic and stashed in `sessionStorage`. It never leaves the browser, and
nothing persistent is keyed against it after the tab closes.

### 2.2 The single non-obvious primitive: a transferable credential

The voter cannot sign the on-chain payload with their real key — that would
identify them. Instead, the coordinator signs **a credential** that says:

> "The bearer of stealth address `S` is allowed to publish exactly one vote
> for proposal `P`. Their dedup tag is `N`."

The credential is just bytes; anybody can verify it against the
coordinator's public key, but only one stealth address can use it (because
the chain enforces that the remark is signed by the address named in the
credential).

A credential is the sr25519 signature, by the coordinator, over:

```
"anon-vote-cred:v1:" || proposalId || stealthAddress || nullifier
```

### 2.3 The dedup tag (nullifier)

To stop a voter from double-voting through two browser sessions, every
credential carries a **nullifier** — a deterministic tag that is the same
for every credential issued to the same real voter on the same proposal,
but reveals nothing about who that voter is:

```
nullifier = HMAC_SHA256( COORD_HMAC_SECRET , proposalId || realAddress )
```

`COORD_HMAC_SECRET` is a long random value held only by the faucet. From
the outside, nullifiers look uniformly random. Crucially:

- Anyone seeing two remarks with the same nullifier knows they came from
  the same real voter, and the second one is dropped during tallying.
- Nobody without the secret can compute the nullifier of a given real
  address. So observers cannot enumerate the 12 allowed voters, compute
  each one's nullifier, and match it against on-chain remarks. The
  allowlist is **not** an enumeration attack surface.
- The nullifier is a function of the secret + proposal + real address —
  not of the stealth address — so the dedup property survives faucet
  restarts and is independent of any per-request state on the backend.

### 2.4 The on-chain payload

The vote published via `system.remark` is a small JSON blob:

```
{
  "v":   1,                  // schema version
  "p":   "proposal-1",       // proposal id
  "s":   "5Foo…",            // stealth address
  "n":   "0x…",              // nullifier (32 bytes hex)
  "c":   "yes" | "no" | "abstain",
  "sig": "0x…"               // coordinator's sr25519 signature over (p,s,n)
}
```

The extrinsic itself is signed on chain by `s`. Nothing in either the
extrinsic or the payload references the real voter's address.

### 2.5 What every observer sees, and what they can't

| Observer can see                                   | Observer cannot see                       |
| -------------------------------------------------- | ----------------------------------------- |
| The set of stealth addresses that submitted remarks | Which real voter owns which stealth      |
| The vote choice attached to each stealth address    | The real voter behind any vote choice    |
| The total count of valid votes                      | Whether a specific real voter has voted  |
| The list of eligible real voters                    | The HMAC secret needed to enumerate them |

The last row is the load-bearing one. Even with the *full* allowlist in
hand, an attacker has no way to invert the nullifier — `HMAC_SHA256` with
an unknown key is a PRF, so its outputs are computationally
indistinguishable from random. The privacy of the vote choice rests on
**exactly the standard PRF assumption on HMAC-SHA256 plus the
unforgeability of sr25519 signatures**, both of which are textbook.

### 2.6 Why this satisfies every requirement

| Requirement                                          | How it's enforced                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------- |
| Only eligible voters may vote                        | Faucet refuses credentials for addresses outside the allowlist + signature check on the request. |
| Each eligible voter votes at most once               | Tally drops repeated nullifiers; nullifier is deterministic in the real address. |
| No observer can link a real voter to a choice        | Stealth address and credential are the only on-chain identifiers, neither of which references the real voter. The nullifier is HMAC-hidden. |
| Result is publicly verifiable                        | Anyone with the chain RPC and the coordinator public key can recompute the tally; no faucet involvement needed for verification. |
| No trusted off-chain storage                         | The chain is the only persistent store. The faucet is stateless. |
| No long-term secret stored in the browser            | Stealth mnemonic lives in `sessionStorage` and is wiped on tab close. Real wallet keys never leave the extension. |

### 2.7 Trust model and known limits

**What you have to trust:**

- The coordinator's `COORD_HMAC_SECRET` and `COORD_MNEMONIC` are not
  exfiltrated. If the secret leaks, an attacker can compute the nullifier
  for every allowed voter and link past on-chain votes to real identities.
  Operationally: keep `.env` secret, rotate per proposal.
- The coordinator does not log the (`realAddress`, `stealthAddress`) pair
  it sees during a fund request. The backend in this repo deliberately
  does not persist these — but a malicious operator who patches it to do
  so would break privacy. This is the price of avoiding a more
  heavyweight zero-knowledge construction.

**What you do *not* have to trust:**

- The chain operator. The chain is just a public bulletin board.
- Other voters. They can publish anything they like in remarks; only
  remarks with a valid coordinator signature and a fresh nullifier are
  counted.
- The faucet's *availability*. If the faucet goes down after issuing your
  credential but before publishing your remark, you can resubmit later
  from any browser; the credential is just bytes.
- The faucet's *correctness in the past*. The credential is a signature,
  not a database row. Anyone can re-verify it months later against the
  coordinator's public key.

**Side-channel residue:**

- On-chain there is a `balances.transferKeepAlive` from the coordinator
  account to each stealth address, immediately preceding the remark from
  that stealth. In isolation this leaks nothing — the coordinator funds
  every stealth, so the funding pattern is the same for everyone — but a
  network observer who *also* watches HTTPS metadata to the faucet at
  millisecond granularity could correlate "real wallet X talked to faucet
  at time T" with "coordinator funded stealth Y at T+ε". Mitigations: run
  the faucet behind HTTPS without access logging; add jitter to funding
  transactions if the threat model warrants it.
- A future stronger version of this design replaces the credential with
  a linkable ring signature over the allowlist, removing the need to
  trust the coordinator at all. That's a pure substitution of step 2.2;
  the rest of the architecture is unchanged.

---

## 3. End-to-end interaction

### 3.1 Voting

```
┌────────┐                 ┌────────┐               ┌──────────┐         ┌──────────┐
│ Voter  │                 │ Faucet │               │ Stealth  │         │  Chain   │
│ (real) │                 │        │               │ wallet   │         │          │
└───┬────┘                 └───┬────┘               └────┬─────┘         └────┬─────┘
    │                          │                         │                     │
    │ 1. Generate stealth      │                         │                     │
    │    keypair locally       │                         │                     │
    │ ────────────────────────────────────────────────► │                     │
    │                          │                         │                     │
    │ 2. Sign "fund:P:S"       │                         │                     │
    │    with REAL key         │                         │                     │
    │                          │                         │                     │
    │ 3. POST /faucet/fund     │                         │                     │
    │    {P, S, real, sig}     │                         │                     │
    │ ────────────────────────►│                         │                     │
    │                          │ verify sig & allowlist  │                     │
    │                          │ compute nullifier       │                     │
    │                          │ sign credential         │                     │
    │                          │ transferKeepAlive(S)    │                     │
    │                          │ ──────────────────────────────────────────────►
    │                          │                         │                     │
    │     4. {nullifier, sig}  │                         │                     │
    │ ◄────────────────────────│                         │                     │
    │                          │                         │                     │
    │ 5. Build remark JSON     │                         │                     │
    │    sign extrinsic with   │                         │                     │
    │    STEALTH key           │                         │                     │
    │ ────────────────────────────────────────────────► │                     │
    │                          │                         │ system.remark(...)  │
    │                          │                         │ ───────────────────►│
    │                          │                         │                     │
```

The real wallet is involved exactly **once**, in step 2, signing a message
that contains only the proposal id and the stealth address. The vote
choice never goes through the real wallet, and never reaches the faucet.

### 3.2 Counting

```
┌──────────┐                                    ┌──────────┐
│ Anyone   │                                    │  Chain   │
│ (UI)     │                                    │          │
└────┬─────┘                                    └────┬─────┘
     │                                                │
     │ scan blocks [startBlock .. head]               │
     │ ──────────────────────────────────────────────►│
     │                                                │
     │   all system.remark extrinsics                 │
     │ ◄──────────────────────────────────────────────│
     │                                                │
     │ for each remark:                               │
     │   parse JSON                                   │
     │   check extrinsic signer == payload.s          │
     │   verify coordinator signature                 │
     │   drop duplicates by nullifier                 │
     │ aggregate yes / no / abstain                   │
     │                                                │
```

Counting is purely a function of `(chain state, coordinator public key)`.
The faucet plays no role at this stage; even if it disappeared after the
last fund call, every browser would still arrive at the same tally.

The coordinator public key needed for verification is fetched once from
`GET /faucet/coord`. The eligible voter list shown in the UI is fetched
from `GET /faucet/voters`, and the active proposal definition (id, title,
description, deadline, quorum, startBlock) from `GET /faucet/proposal`.
None of these endpoints takes input; all are pure reads of static
configuration.

---

## 4. Configuration

The faucet is configured entirely through environment variables. See
[`packages/api/.env.example`](packages/api/.env.example) for the full list,
including:

- `SUBTENSOR_WS` — WebSocket RPC of the target chain (defaults to the
  Bittensor finney testnet).
- `COORD_MNEMONIC` — sr25519 mnemonic for the coordinator account. The
  derived address must be pre-funded with TAO; it pays the funding
  transfers and is the public verification key for credentials.
- `COORD_HMAC_SECRET` — the PRF key for nullifier derivation. Must be
  long, random, and stable for the lifetime of a proposal.
- `PROPOSAL_ID` / `PROPOSAL_TITLE` / `PROPOSAL_DESCRIPTION` — proposal
  identity and copy shown in the UI.
- `PROPOSAL_DEADLINE` — ISO timestamp after which voting is considered
  closed.
- `PROPOSAL_QUORUM` — minimum number of valid votes required for the
  result to count.
- `PROPOSAL_START_BLOCK` — first block to scan when tallying remarks.
- `ALLOWED_VOTERS` — comma-separated SS58 addresses on the allowlist.
- `FUND_AMOUNT_RAO` / `MIN_STEALTH_BALANCE_RAO` — funding policy.

The UI takes only `VITE_FAUCET_URL` (default `http://localhost:3000`) and
`VITE_SUBTENSOR_WS`. Everything else — the active proposal, the voter
list, the coordinator public key — is fetched at runtime from the faucet.

---

## 5. Running locally

```
# 1. install workspace deps
npm install

# 2. configure the faucet
cp packages/api/.env.example packages/api/.env
$EDITOR packages/api/.env       # set COORD_MNEMONIC, COORD_HMAC_SECRET, fund the coord on testnet

# 3. start the faucet
npm run api:dev

# 4. start the UI (in another terminal)
npm run ui:dev
```
