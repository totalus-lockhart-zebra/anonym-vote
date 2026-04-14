#!/usr/bin/env node
/**
 * anon-vote CLI — auditor + voter tooling.
 */

import { Command, Option } from 'commander';
import { runVerify } from './commands/verify';
import { runAnnounce } from './commands/announce';
import { runVote } from './commands/vote';
import type { Choice } from '@anon-vote/shared';
import type { WalletSource } from './wallet';
import { defaultKeyDir } from './keystore';

const program = new Command();

program
  .name('anon-vote')
  .description('Auditor + voter CLI for anon-vote proposals')
  .version('0.1.0');

/** Shared wallet flags — re-used by announce and vote. */
function addWalletFlags(cmd: Command): Command {
  return cmd
    .option(
      '--mnemonic <phrase>',
      'BIP39 mnemonic for the real wallet (or set MNEMONIC env)',
    )
    .option(
      '--json-file <path>',
      'Polkadot-JS keystore JSON export for the real wallet',
    )
    .option(
      '--password <pw>',
      'Password to decrypt --json-file (or set JSON_PASSWORD env)',
    );
}

function walletSource(opts: {
  mnemonic?: string;
  jsonFile?: string;
  password?: string;
}): WalletSource {
  return {
    mnemonic: opts.mnemonic,
    jsonFile: opts.jsonFile,
    password: opts.password,
  };
}

/** Shared `--key-dir` option. */
const keyDirOption = new Option(
  '--key-dir <path>',
  'Directory for per-voter secrets (voting keys, gas mnemonics)',
).default(defaultKeyDir());

// ─── verify ────────────────────────────────────────────────────────────────

program
  .command('verify')
  .description(
    'Scan chain, reconstruct the ring, verify every ring signature, ' +
      'and print the tally. Proposal metadata is pulled from /faucet/info ' +
      'by default; override any field with the flags below.',
  )
  .requiredOption('--ws <url>', 'Subtensor WS endpoint')
  .requiredOption('--expected-genesis <hex>', 'Pinned genesis hash')
  .requiredOption(
    '--faucet-url <url>',
    'Faucet base URL (source of truth for proposalId, startBlock, allowlist, coordinator)',
  )
  .option('--proposal <id>', 'Override proposalId (default: from /faucet/info)')
  .option(
    '--start-block <n>',
    'Override start block (default: from /faucet/info)',
    (v) => Number.parseInt(v, 10),
  )
  .option(
    '--allowed <csv>',
    'Override allowlist (default: from /faucet/info)',
    (v) => v.split(',').map((s) => s.trim()).filter(Boolean),
  )
  .option(
    '--coordinator <addr>',
    'Override coordinator SS58 (default: from /faucet/info)',
  )
  .option('--to-block <n>', 'Last block to include', (v) => Number.parseInt(v, 10))
  .option('--concurrency <n>', 'Parallel block fetches', (v) => Number.parseInt(v, 10), 16)
  .option('--json', 'Machine-readable output', false)
  .action(async (opts) => {
    const code = await runVerify({
      ws: opts.ws,
      expectedGenesis: opts.expectedGenesis,
      faucetUrl: opts.faucetUrl,
      proposal: opts.proposal,
      startBlock: opts.startBlock,
      allowed: opts.allowed,
      coordinator: opts.coordinator,
      toBlock: opts.toBlock,
      concurrency: opts.concurrency,
      json: Boolean(opts.json),
    });
    process.exit(code);
  });

// ─── announce ──────────────────────────────────────────────────────────────

addWalletFlags(
  program
    .command('announce')
    .description(
      'Generate (or re-use) a voting key for your wallet and publish ' +
        'the announce remark. Run this once per proposal per real ' +
        'wallet, before voting opens.',
    )
    .requiredOption('--ws <url>', 'Subtensor WS endpoint')
    .requiredOption('--expected-genesis <hex>', 'Pinned genesis hash')
    .requiredOption('--proposal <id>', 'Proposal id')
    .addOption(keyDirOption),
).action(async (opts) => {
  const code = await runAnnounce({
    ws: opts.ws,
    expectedGenesis: opts.expectedGenesis,
    proposal: opts.proposal,
    keyDir: opts.keyDir,
    wallet: walletSource(opts),
  });
  process.exit(code);
});

// ─── vote ──────────────────────────────────────────────────────────────────

addWalletFlags(
  program
    .command('vote')
    .description(
      'Cast a vote: ring-sign a drip request, wait for gas funds from ' +
        'the faucet, then ring-sign and publish the vote remark via ' +
        'a one-shot gas wallet. Announce must be on chain already.',
    )
    .requiredOption('--ws <url>', 'Subtensor WS endpoint')
    .requiredOption('--expected-genesis <hex>', 'Pinned genesis hash')
    .requiredOption('--faucet-url <url>', 'Faucet base URL (source of truth for proposalId, startBlock, allowlist)')
    .requiredOption(
      '--choice <yes|no|abstain>',
      'Your choice',
      (v): Choice => {
        if (v !== 'yes' && v !== 'no' && v !== 'abstain') {
          throw new Error(`--choice must be yes | no | abstain (got "${v}")`);
        }
        return v;
      },
    )
    .option(
      '--proposal <id>',
      'Override proposalId (default: from /faucet/info)',
    )
    .option(
      '--start-block <n>',
      'Override start block (default: from /faucet/info)',
      (v) => Number.parseInt(v, 10),
    )
    .option(
      '--allowed <csv>',
      'Override allowlist (default: from /faucet/info)',
      (v) => v.split(',').map((s) => s.trim()).filter(Boolean),
    )
    .option(
      '--gas-timeout <ms>',
      'How long to wait for gas wallet to be funded',
      (v) => Number.parseInt(v, 10),
      180_000,
    )
    .addOption(keyDirOption),
).action(async (opts) => {
  const code = await runVote({
    ws: opts.ws,
    expectedGenesis: opts.expectedGenesis,
    proposal: opts.proposal,
    choice: opts.choice,
    startBlock: opts.startBlock,
    allowed: opts.allowed,
    faucetUrl: opts.faucetUrl,
    keyDir: opts.keyDir,
    gasTimeoutMs: opts.gasTimeout,
    wallet: walletSource(opts),
  });
  process.exit(code);
});

program.parseAsync(process.argv).catch((e) => {
  process.stderr.write(
    `\nerror: ${e instanceof Error ? e.message : String(e)}\n`,
  );
  process.exit(2);
});
