/**
 * `anon-vote vote` — cast a vote for the given proposal. Linear mirror
 * of the UI's `cast()` flow:
 *
 *   1. Load real wallet + stored voting key.
 *   2. Connect, genesis-check, scan remarks, reconstruct the canonical
 *      ring at chain head.
 *   3. Refuse if our VK isn't in the ring (we'd need to announce first).
 *   4. Load-or-create a one-shot gas wallet mnemonic in the keystore.
 *   5. Ring-sign the drip message, POST to faucet, wait for gas funds.
 *   6. Ring-sign the vote message at the same ring block, encode, and
 *      publish via the gas wallet so the extrinsic signer is not our
 *      real address — that's where the anonymity comes from.
 */

import { Keyring } from '@polkadot/keyring';
import type { KeyringPair } from '@polkadot/keyring/types';
import { mnemonicGenerate } from '@polkadot/util-crypto';
import {
  computeRingAt,
  dripMessageHex,
  encodeVoteRemark,
  voteMessageHex,
  type Choice,
  type RemarkLike,
} from '@anon-vote/shared';
import { connect, scanRemarks } from '../chain';
import { sendRemark, waitForBalance } from '../extrinsic';
import { getFaucetInfo, requestDrip } from '../faucet';
import {
  defaultKeyDir,
  readGasWallet,
  readVotingKey,
  writeGasWallet,
} from '../keystore';
import { sign as ringSign } from '../ring-sig';
import { loadWallet, type WalletSource } from '../wallet';

const MIN_GAS_BALANCE_RAO = 100_000n;

export interface VoteArgs {
  ws: string;
  expectedGenesis: string;
  proposal?: string;
  choice: Choice;
  /** Optional override; defaults to value from `/faucet/info`. */
  startBlock?: number;
  /** Optional override; defaults to value from `/faucet/info`. */
  allowed?: string[];
  faucetUrl: string;
  keyDir: string;
  gasTimeoutMs: number;
  wallet: WalletSource;
}

export async function runVote(args: VoteArgs): Promise<number> {
  const pair = await loadWallet(args.wallet);
  process.stderr.write(`Loaded wallet ${pair.address}\n`);

  // Pull proposalId / startBlock / allowedVoters from the faucet unless
  // the caller explicitly overrode them. The faucet is the source of
  // truth for drip verification, so its allowlist MUST match whatever
  // we sign against — pulling from there guarantees consistency.
  process.stderr.write(`Fetching faucet info from ${args.faucetUrl}…\n`);
  const info = await getFaucetInfo(args.faucetUrl);
  if (args.proposal && args.proposal !== info.proposalId) {
    throw new Error(
      `--proposal "${args.proposal}" disagrees with faucet ("${info.proposalId}")`,
    );
  }
  const proposalId = args.proposal ?? info.proposalId;
  const startBlock = args.startBlock ?? info.startBlock;
  const allowed = args.allowed ?? info.allowedVoters;
  process.stderr.write(
    `Faucet: proposal=${info.proposalId}  startBlock=${info.startBlock}  allowed=${info.allowedVoters.length}\n`,
  );

  const chain = await connect(args.ws, args.expectedGenesis);
  process.stderr.write(
    `Connected. head=${chain.head} genesis=${chain.genesisHash}\n`,
  );

  try {
    const keyDir = args.keyDir || defaultKeyDir();
    const vk = readVotingKey(keyDir, proposalId, pair.address);
    if (!vk) {
      throw new Error(
        `No voting key for (${proposalId}, ${pair.address}) under ${keyDir}. ` +
          `Run \`anon-vote announce …\` first.`,
      );
    }

    process.stderr.write(
      `Scanning remarks [${startBlock}..${chain.head}] to build ring…\n`,
    );
    const remarks: RemarkLike[] = await scanRemarks(
      chain.api,
      startBlock,
      chain.head,
      {
        onProgress: (done, total) => {
          if (done % 200 === 0 || done === total) {
            const pct = ((done / total) * 100).toFixed(1);
            process.stderr.write(`\r  scanned ${done}/${total} (${pct}%)`);
          }
        },
      },
    );
    process.stderr.write('\n');

    const allowedSet = new Set(allowed);
    const ringBlock = chain.head;
    const ring = computeRingAt(remarks, {
      proposalId: proposalId,
      atBlock: ringBlock,
      allowedRealAddresses: allowedSet,
    });

    if (ring.length < 2) {
      throw new Error(
        `Canonical ring at block ${ringBlock} has only ${ring.length} member(s); ` +
          `BLSAG needs ≥2. At least one other allowlisted voter must announce first.`,
      );
    }
    if (!ring.includes(vk.pk)) {
      throw new Error(
        `Your voting key ${vk.pk.slice(0, 16)}… is not in the canonical ring at block ${ringBlock}. ` +
          `The ring is first-wins per signer — if you announced a different VK earlier it stays pinned. ` +
          `Stored key path: ${keyDir}/${proposalId}/${pair.address}.voting-key.json`,
      );
    }
    process.stderr.write(`Ring size ${ring.length}, VK included. ringBlock=${ringBlock}\n`);

    // Gas wallet: reuse if stored (survives across retries), otherwise fresh.
    const keyring = new Keyring({ type: 'sr25519' });
    const storedGas = readGasWallet(keyDir, proposalId, pair.address);
    const mnemonic = storedGas?.mnemonic ?? mnemonicGenerate();
    if (!storedGas) {
      const path = writeGasWallet(keyDir, proposalId, pair.address, mnemonic);
      process.stderr.write(`Generated fresh gas wallet, wrote ${path}\n`);
    } else {
      process.stderr.write('Re-using stored gas wallet.\n');
    }
    const gasPair: KeyringPair = keyring.addFromUri(mnemonic);
    process.stderr.write(`Gas address: ${gasPair.address}\n`);

    // Drip: ring-sign the drip message and ask the faucet for funds.
    process.stderr.write('Requesting faucet drip…\n');
    const dripSig = ringSign(
      vk.sk,
      ring,
      dripMessageHex(proposalId, gasPair.address, ringBlock),
    );
    const drip = await requestDrip(args.faucetUrl, {
      proposalId: proposalId,
      gasAddress: gasPair.address,
      ringBlock,
      ringSig: dripSig,
    });
    process.stderr.write(`Drip sent in block ${drip.blockHash}\n`);

    // Wait until the gas wallet has enough free balance to pay fees.
    process.stderr.write(
      `Waiting for gas wallet to reach ${MIN_GAS_BALANCE_RAO} rao…\n`,
    );
    await waitForBalance(chain.api, gasPair.address, MIN_GAS_BALANCE_RAO, {
      timeoutMs: args.gasTimeoutMs,
      onTick: (free) => {
        process.stderr.write(`\r  free=${free}`);
      },
    });
    process.stderr.write('\n');

    // Ring-sign vote at the SAME ringBlock (the chain verifies against
    // whatever `rb` the remark embeds).
    const voteSig = ringSign(
      vk.sk,
      ring,
      voteMessageHex(proposalId, args.choice, ringBlock),
    );
    const voteText = encodeVoteRemark({
      proposalId: proposalId,
      choice: args.choice,
      ringBlock,
      sig: voteSig,
    });

    process.stderr.write('Publishing vote via gas wallet…\n');
    const sent = await sendRemark(chain.api, gasPair, voteText);

    process.stdout.write(
      JSON.stringify(
        {
          address: pair.address,
          proposalId: proposalId,
          choice: args.choice,
          ringBlock,
          ringSize: ring.length,
          keyImage: voteSig.key_image,
          gasAddress: gasPair.address,
          dripBlockHash: drip.blockHash,
          voteBlockHash: sent.blockHash,
          voteBlockNumber: sent.blockNumber,
        },
        null,
        2,
      ) + '\n',
    );
    return 0;
  } finally {
    await chain.disconnect();
  }
}
