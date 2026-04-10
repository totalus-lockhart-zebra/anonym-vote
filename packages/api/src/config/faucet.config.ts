import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

/**
 * Runtime configuration for the faucet.
 *
 * Sourced entirely from environment variables. Missing required values
 * are fatal — we'd rather crash at boot than sign credentials against a
 * misconfigured coordinator key.
 */
export interface ProposalConfig {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly deadline: string;
  readonly quorum: number;
  readonly startBlock: number;
}

@Injectable()
export class FaucetConfig implements OnModuleInit {
  private readonly logger = new Logger(FaucetConfig.name);

  readonly subtensorWs: string;
  readonly coordMnemonic: string;
  readonly coordHmacSecret: string;
  readonly allowedVoters: readonly string[];
  readonly proposal: ProposalConfig;
  readonly fundAmountRao: bigint;
  readonly minStealthBalanceRao: bigint;
  readonly port: number;
  readonly corsOrigins: string[];

  get proposalId(): string {
    return this.proposal.id;
  }

  constructor() {
    this.subtensorWs =
      process.env.SUBTENSOR_WS ?? 'wss://test.finney.opentensor.ai:443';

    this.coordMnemonic = required('COORD_MNEMONIC');
    this.coordHmacSecret = required('COORD_HMAC_SECRET');

    const deadline = required('PROPOSAL_DEADLINE');
    if (Number.isNaN(Date.parse(deadline))) {
      throw new Error(
        `PROPOSAL_DEADLINE must be a valid ISO date string, got "${deadline}"`,
      );
    }
    const quorum = Number(required('PROPOSAL_QUORUM'));
    if (!Number.isInteger(quorum) || quorum < 0) {
      throw new Error('PROPOSAL_QUORUM must be a non-negative integer');
    }
    const startBlock = Number(required('PROPOSAL_START_BLOCK'));
    if (!Number.isInteger(startBlock) || startBlock < 0) {
      throw new Error('PROPOSAL_START_BLOCK must be a non-negative integer');
    }

    this.proposal = {
      id: required('PROPOSAL_ID'),
      title: required('PROPOSAL_TITLE'),
      description: required('PROPOSAL_DESCRIPTION'),
      deadline,
      quorum,
      startBlock,
    };

    // Comma-separated SS58 addresses. Must match the list shown in the UI.
    const votersEnv = required('ALLOWED_VOTERS');
    this.allowedVoters = votersEnv
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean);
    if (this.allowedVoters.length === 0) {
      throw new Error('ALLOWED_VOTERS must contain at least one address');
    }

    this.fundAmountRao = BigInt(process.env.FUND_AMOUNT_RAO ?? '200000');
    this.minStealthBalanceRao = BigInt(
      process.env.MIN_STEALTH_BALANCE_RAO ?? '100000',
    );

    this.port = Number(process.env.PORT ?? 3000);

    this.corsOrigins = (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
  }

  onModuleInit() {
    this.logger.log(`Subtensor WS:        ${this.subtensorWs}`);
    this.logger.log(`Proposal id:         ${this.proposal.id}`);
    this.logger.log(`Proposal deadline:   ${this.proposal.deadline}`);
    this.logger.log(`Proposal quorum:     ${this.proposal.quorum}`);
    this.logger.log(`Proposal startBlock: ${this.proposal.startBlock}`);
    this.logger.log(`Allowed voters:      ${this.allowedVoters.length}`);
    this.logger.log(`Fund amount:         ${this.fundAmountRao} rao`);
    this.logger.log(`Min stealth balance: ${this.minStealthBalanceRao} rao`);
    this.logger.log(`CORS origins:        ${this.corsOrigins.join(', ')}`);
  }
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`Required env var ${name} is not set`);
  }
  return v;
}
