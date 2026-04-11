import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { decodeAddress } from '@polkadot/util-crypto';
import { FaucetConfig } from '../config/faucet.config';
import { DripRequestDto } from './drip-request.dto';
import { RingIndexerService } from './ring-indexer.service';
import { verifyRingSig } from './ring-sig-verifier';
import { dripMessageHex } from '@anon-vote/shared';
import { SubtensorService } from './subtensor.service';

export interface DripResponse {
  /** Block hash the transfer landed in. */
  blockHash: string;
  /** The gas address that was funded — echoed for client clarity. */
  gasAddress: string;
}

export interface FaucetInfo {
  faucetAddress: string;
  proposalId: string;
  startBlock: number;
  scannedThrough: number;
  head: number;
  announcedVoterCount: number;
  /**
   * Approximate remaining budget in rao —
   * `fundAmountRao * (allowedVoters - drippedCount)`, floored at
   * zero. Clients can show this as transparency; the real
   * enforcement is in `processDrip`.
   */
  remainingBudgetRao: string;
}

/**
 * Trust-minimized drip flow.
 *
 * `processDrip` is the entire HTTP-facing surface that voters touch.
 * Steps:
 *
 *   1. Sanity-check the proposal id and address format.
 *   2. Reconstruct the ring at the caller's `ringBlock`. The
 *      indexer must have already scanned through that block;
 *      otherwise we'd be verifying against a half-formed snapshot.
 *   3. Verify the BLSAG ring signature against that ring + the
 *      drip-message bytes. A valid sig proves "some ring member
 *      authorized this drip" — it does not say which.
 *   4. Dedup by `sig.key_image`. BLSAG key images are deterministic
 *      per secret key, so the same voter cannot pull a second drip
 *      under a different `gasAddress`.
 *   5. Budget cap: never transfer more than
 *      `fundAmountRao * allowedVoters` over the lifetime of the
 *      service, even if dedup is corrupted.
 *   6. `balances.transferKeepAlive` from the faucet mnemonic.
 *
 * The key image set is in-memory by design — see design notes.
 */
@Injectable()
export class FaucetService {
  private readonly logger = new Logger(FaucetService.name);

  /** Key images we've already dripped for. In-memory by design. */
  private readonly usedKeyImages = new Set<string>();
  /** Running total of rao sent out, capped by the per-proposal budget. */
  private spentRao = 0n;

  constructor(
    private readonly config: FaucetConfig,
    private readonly subtensor: SubtensorService,
    private readonly ringIndexer: RingIndexerService,
  ) {}

  async processDrip(req: DripRequestDto): Promise<DripResponse> {
    // 1. Proposal id must match — the faucet is proposal-scoped
    //    and can't be used for anything else.
    if (req.proposalId !== this.config.proposalId) {
      throw new BadRequestException(
        `proposalId mismatch: expected "${this.config.proposalId}"`,
      );
    }

    try {
      decodeAddress(req.gasAddress);
    } catch {
      throw new BadRequestException('gasAddress is not a valid SS58 address');
    }

    // 2. ringBlock bounds. Must be at or after startBlock and at
    //    or before what we've actually scanned. Anything in the
    //    future means the voter is using a head we haven't caught
    //    up to yet — we ask them to retry.
    if (req.ringBlock < this.config.proposal.startBlock) {
      throw new BadRequestException(
        `ringBlock ${req.ringBlock} is before proposal startBlock ${this.config.proposal.startBlock}`,
      );
    }
    if (req.ringBlock > this.ringIndexer.getScannedThrough()) {
      throw new ServiceUnavailableException(
        `Indexer has not yet caught up to ringBlock ${req.ringBlock} (current: ${this.ringIndexer.getScannedThrough()}). Retry shortly.`,
      );
    }

    // 3. Reconstruct the ring exactly as the voter saw it at sign
    //    time, using the same shared logic that runs in the browser.
    const ring = this.ringIndexer.getRingAt(req.ringBlock);
    if (!ring) {
      // Should not happen given the bounds check above; defensive.
      throw new ServiceUnavailableException(
        'Ring reconstruction failed unexpectedly.',
      );
    }
    if (ring.length < 2) {
      throw new BadRequestException(
        `Ring at block ${req.ringBlock} has only ${ring.length} member(s); need at least 2 announces before voting.`,
      );
    }

    // 4. Ring-sig verification. The voter signed
    //    `drip:<proposalId>:<gasAddress>:<ringBlock>` against this
    //    same ring; we recompute the bytes and verify.
    const msgHex = dripMessageHex(
      req.proposalId,
      req.gasAddress,
      req.ringBlock,
    );
    const ok = verifyRingSig(req.ringSig, ring, msgHex);
    if (!ok) {
      this.logger.warn(
        `drip rejected: sig verify failed (ring=${ring.length}, rb=${req.ringBlock})`,
      );
      throw new BadRequestException('Ring signature did not verify.');
    }

    // 5. Dedup. BLSAG key images are deterministic per sk, so the
    //    same voter asking twice lands on the same key image even
    //    if they switched gas addresses or ringBlocks.
    const keyImage = req.ringSig.key_image.toLowerCase();
    if (this.usedKeyImages.has(keyImage)) {
      throw new ConflictException(
        'This voter has already received a drip for this proposal.',
      );
    }

    // 6. Budget ceiling. Even if dedup state is corrupted we can't
    //    spend more than `fundAmountRao * allowedVoters` total.
    //    Using allowedVoters (not current ring size) makes the
    //    cap stable as the ring grows.
    const maxBudget =
      this.config.fundAmountRao * BigInt(this.config.allowedVoters.length);
    if (this.spentRao + this.config.fundAmountRao > maxBudget) {
      throw new HttpException(
        'Faucet budget for this proposal is exhausted.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // 7. Pre-reserve before issuing the transfer so concurrent
    //    requests can't double-spend the cap. Roll back on failure.
    this.spentRao += this.config.fundAmountRao;
    this.usedKeyImages.add(keyImage);

    try {
      this.logger.log(
        `drip: gas=${req.gasAddress} ring=${ring.length} ` +
          `rb=${req.ringBlock} keyImage=${keyImage.slice(0, 12)}…`,
      );
      const blockHash = await this.subtensor.fundAddress(
        req.gasAddress,
        this.config.fundAmountRao,
      );
      return { blockHash, gasAddress: req.gasAddress };
    } catch (err) {
      this.spentRao -= this.config.fundAmountRao;
      this.usedKeyImages.delete(keyImage);
      this.logger.error(
        `drip transfer failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new ServiceUnavailableException('Transfer failed; try again.');
    }
  }

  getInfo(): FaucetInfo {
    const totalAllowed = this.config.allowedVoters.length;
    const maxBudget = this.config.fundAmountRao * BigInt(totalAllowed);
    const remaining = maxBudget > this.spentRao ? maxBudget - this.spentRao : 0n;
    return {
      faucetAddress: this.subtensor.getFaucetAddress(),
      proposalId: this.config.proposalId,
      startBlock: this.config.proposal.startBlock,
      scannedThrough: this.ringIndexer.getScannedThrough(),
      head: this.ringIndexer.getHead(),
      announcedVoterCount: this.ringIndexer.getAnnouncedVoterCount(),
      remainingBudgetRao: remaining.toString(),
    };
  }
}
