import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

/**
 * Runtime configuration for the v2 faucet.
 *
 * In v1 this held a coordinator mnemonic + HMAC secret and used them to
 * sign eligibility credentials. In v2 the faucet holds neither of those —
 * it is a trust-minimized service whose only job is to send a single TAO
 * transfer to any requester who can produce a valid ring signature over
 * the announced voting keys. There are no secrets beyond the faucet
 * mnemonic itself (which just pays gas, like any Polkadot wallet).
 *
 * Every field is sourced from env vars. Missing required values are
 * fatal — we'd rather crash at boot than accept drip requests against a
 * misconfigured faucet.
 */
export interface ProposalConfig {
  readonly id: string;
  /**
   * First block scanned for announce remarks. There is no end
   * block — voting is open-ended, late voters are explicitly
   * supported, and per-proposal isolation is achieved by setting a
   * fresh `startBlock` for each new proposal.
   */
  readonly startBlock: number;
}

@Injectable()
export class FaucetConfig implements OnModuleInit {
  private readonly logger = new Logger(FaucetConfig.name);

  readonly subtensorWs: string;
  readonly faucetMnemonic: string;
  readonly allowedVoters: readonly string[];
  readonly proposal: ProposalConfig;
  readonly fundAmountRao: bigint;
  readonly port: number;
  readonly corsOrigins: string[];

  get proposalId(): string {
    return this.proposal.id;
  }

  constructor() {
    this.subtensorWs =
      process.env.SUBTENSOR_WS ?? 'wss://test.finney.opentensor.ai:443';

    this.faucetMnemonic = required('FAUCET_MNEMONIC');

    const startBlock = Number(required('PROPOSAL_START_BLOCK'));
    if (!Number.isInteger(startBlock) || startBlock < 0) {
      throw new Error('PROPOSAL_START_BLOCK must be a non-negative integer');
    }

    this.proposal = {
      id: required('PROPOSAL_ID'),
      startBlock,
    };

    // Comma-separated SS58 addresses. Must exactly match the UI's
    // proposal.ts — the ring reconstruction on both sides has to agree
    // byte-for-byte, otherwise sigs verified on the client fail on the
    // server.
    const votersEnv = required('ALLOWED_VOTERS');
    this.allowedVoters = votersEnv
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean);
    if (this.allowedVoters.length === 0) {
      throw new Error('ALLOWED_VOTERS must contain at least one address');
    }

    this.fundAmountRao = BigInt(process.env.FUND_AMOUNT_RAO ?? '200000');

    this.port = Number(process.env.PORT ?? 3000);

    this.corsOrigins = (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
  }

  onModuleInit() {
    this.logger.log(`Subtensor WS:             ${this.subtensorWs}`);
    this.logger.log(`Proposal id:              ${this.proposal.id}`);
    this.logger.log(`Start block:              ${this.proposal.startBlock}`);
    this.logger.log(`Allowed voters:           ${this.allowedVoters.length}`);
    this.logger.log(`Fund amount:              ${this.fundAmountRao} rao`);
    this.logger.log(`CORS origins:             ${this.corsOrigins.join(', ')}`);
  }
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`Required env var ${name} is not set`);
  }
  return v;
}
