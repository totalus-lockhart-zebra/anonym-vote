import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { u8aToHex } from '@polkadot/util';
import {
  decodeAddress,
  encodeAddress,
  cryptoWaitReady,
} from '@polkadot/util-crypto';
import { FaucetConfig } from '../config/faucet.config';
import {
  computeNullifier,
  credentialMessage,
  fundRequestMessage,
  verifyWalletSignature,
} from './crypto.util';
import { FundRequestDto } from './dto/fund-request.dto';
import { SubtensorService } from './subtensor.service';

export interface CredentialResponse {
  proposalId: string;
  stealthAddress: string;
  nullifier: string;
  credSig: string;
}

@Injectable()
export class FaucetService {
  private readonly logger = new Logger(FaucetService.name);
  private readonly allowedNormalised: Set<string>;

  constructor(
    private readonly config: FaucetConfig,
    private readonly subtensor: SubtensorService,
  ) {
    this.allowedNormalised = new Set(
      config.allowedVoters.map((a) => FaucetService.normaliseAddress(a)),
    );
  }

  /**
   * Process a fund+credential request. Does:
   *   1. Validate SS58 addresses
   *   2. Check proposal id matches the active one
   *   3. Check real voter is in the allowlist
   *   4. Verify the wallet signature over fundRequestMessage
   *   5. Fund stealth address if below min balance
   *   6. Issue coordinator-signed credential
   */
  async issueCredential(req: FundRequestDto): Promise<CredentialResponse> {
    await cryptoWaitReady();

    // 1. SS58 sanity — decode throws if the shape is wrong.
    this.mustDecodeAddress(req.stealthAddress, 'stealthAddress');
    const realRaw = this.mustDecodeAddress(req.realAddress, 'realAddress');

    // 2. Proposal id
    if (req.proposalId !== this.config.proposalId) {
      throw new BadRequestException(
        `proposalId mismatch: expected "${this.config.proposalId}"`,
      );
    }

    // 3. Allowlist
    const realNormalised = encodeAddress(realRaw, 42);
    if (!this.allowedNormalised.has(realNormalised)) {
      throw new ForbiddenException('realAddress is not an allowed voter');
    }

    // 4. Wallet signature — bind real voter to stealth address
    const msg = fundRequestMessage(req.proposalId, req.stealthAddress);
    if (!verifyWalletSignature(msg, req.realSignature, req.realAddress)) {
      throw new ForbiddenException('realSignature did not verify');
    }

    // 5. Fund the stealth address if it doesn't have enough
    let balance: bigint;
    try {
      balance = await this.subtensor.getFreeBalance(req.stealthAddress);
    } catch (err) {
      this.logger.error(`Failed to read stealth balance: ${errMsg(err)}`);
      throw new ServiceUnavailableException('Subtensor RPC unavailable');
    }

    if (balance < this.config.minStealthBalanceRao) {
      this.logger.log(
        `Funding ${req.stealthAddress} with ${this.config.fundAmountRao} rao ` +
          `(current balance ${balance})`,
      );
      try {
        const blockHash = await this.subtensor.fundAddress(
          req.stealthAddress,
          this.config.fundAmountRao,
        );
        this.logger.log(`Funding landed in ${blockHash}`);
      } catch (err) {
        this.logger.error(`Funding transfer failed: ${errMsg(err)}`);
        throw new ServiceUnavailableException('Funding transfer failed');
      }
    } else {
      this.logger.log(
        `Skipping funding — ${req.stealthAddress} already has ${balance} rao`,
      );
    }

    // 6. Sign the credential. Note the nullifier is a function of the REAL
    // address, not the stealth one — that's how we deduplicate across
    // faucet restarts and cross-tab voting.
    const nullifier = computeNullifier(
      this.config.coordHmacSecret,
      req.proposalId,
      realNormalised,
    );
    const credMsg = credentialMessage(
      req.proposalId,
      req.stealthAddress,
      nullifier,
    );
    const credSig = this.subtensor.signWithCoord(credMsg);

    return {
      proposalId: req.proposalId,
      stealthAddress: req.stealthAddress,
      nullifier,
      credSig: u8aToHex(credSig),
    };
  }

  getCoordAddress(): string {
    return this.subtensor.getCoordAddress();
  }

  private mustDecodeAddress(addr: string, field: string): Uint8Array {
    try {
      return decodeAddress(addr);
    } catch {
      throw new BadRequestException(`${field} is not a valid SS58 address`);
    }
  }

  private static normaliseAddress(addr: string): string {
    return encodeAddress(decodeAddress(addr), 42);
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
