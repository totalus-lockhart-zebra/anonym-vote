/**
 * `anon-vote announce` — publish (or re-use) a voting-key announce
 * for the given proposal. Mirrors the UI's "Register" flow.
 *
 * If the voter already has a stored VK for (proposalId, realAddress),
 * we re-use it; otherwise a fresh one is generated and written to the
 * keystore. The announce remark is signed by the real wallet.
 */

import { encodeAnnounceRemark } from '@anon-vote/shared';
import { connect } from '../chain';
import { sendRemark } from '../extrinsic';
import {
  defaultKeyDir,
  readVotingKey,
  writeVotingKey,
} from '../keystore';
import { keygen } from '../ring-sig';
import { loadWallet, type WalletSource } from '../wallet';

export interface AnnounceArgs {
  ws: string;
  expectedGenesis: string;
  proposal: string;
  keyDir: string;
  wallet: WalletSource;
}

export async function runAnnounce(args: AnnounceArgs): Promise<number> {
  const pair = await loadWallet(args.wallet);
  process.stderr.write(`Loaded wallet ${pair.address}\n`);

  const chain = await connect(args.ws, args.expectedGenesis);
  process.stderr.write(
    `Connected. head=${chain.head} genesis=${chain.genesisHash}\n`,
  );

  try {
    const keyDir = args.keyDir || defaultKeyDir();

    let vk = readVotingKey(keyDir, args.proposal, pair.address);
    let reused = false;
    if (vk) {
      reused = true;
      process.stderr.write(`Re-using stored voting key for this address.\n`);
    } else {
      const fresh = keygen();
      const path = writeVotingKey(keyDir, args.proposal, pair.address, fresh);
      vk = { sk: fresh.sk, pk: fresh.pk, createdAt: new Date().toISOString() };
      process.stderr.write(`Generated fresh voting key, wrote ${path}\n`);
    }

    const text = encodeAnnounceRemark(args.proposal, vk.pk);
    process.stderr.write(`Publishing announce remark…\n  ${text}\n`);

    const sent = await sendRemark(chain.api, pair, text);
    process.stdout.write(
      JSON.stringify(
        {
          address: pair.address,
          proposalId: args.proposal,
          vkPub: vk.pk,
          reused,
          blockHash: sent.blockHash,
          blockNumber: sent.blockNumber,
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
