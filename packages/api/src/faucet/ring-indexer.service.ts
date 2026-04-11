import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { u8aToString } from '@polkadot/util';
import type { UnsubscribePromise } from '@polkadot/api/types';
import { FaucetConfig } from '../config/faucet.config';
import { SubtensorService } from './subtensor.service';
import {
  computeRingAt,
  parseAnnounceRemark,
  type RemarkLike,
} from '@anon-vote/shared';

/**
 * Server-side live ring indexer.
 *
 * Responsibilities:
 *   1. On boot: catch up by scanning every block from
 *      `config.proposal.startBlock` to current head.
 *   2. Subscribe to new heads; on each new head, scan the delta
 *      range and append any new announce remarks to the in-memory
 *      list.
 *   3. Expose `getRingAt(block)` so the faucet can verify ring
 *      signatures committed to any specific past ringBlock.
 *
 * Why live and not one-shot anymore: in the v2 flow there is no
 * announce window. Voters announce lazily on first vote, so the
 * announce set grows alongside the vote set. The faucet must keep
 * up with each new announce so that subsequent drip requests with
 * a fresh ringBlock can be verified.
 *
 * The shared `parseAnnounceRemark` and `computeRingAt` are imported
 * directly — single source of truth with the browser indexer.
 */
@Injectable()
export class RingIndexerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RingIndexerService.name);

  private readonly remarks: RemarkLike[] = [];
  private headBlock = 0;
  private scannedThrough: number;
  private destroyed = false;
  private unsubHead: UnsubscribePromise | null = null;
  private catchUpInFlight: Promise<void> | null = null;

  constructor(
    private readonly config: FaucetConfig,
    private readonly subtensor: SubtensorService,
  ) {
    this.scannedThrough = this.config.proposal.startBlock - 1;
  }

  onModuleInit(): void {
    void this.start().catch((err) => {
      this.logger.error(
        `Ring indexer failed to start: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.unsubHead) {
      void this.unsubHead.then((u) => u());
      this.unsubHead = null;
    }
  }

  /**
   * The faucet calls this on every drip request to reconstruct the
   * exact ring the voter signed against. Returns null if the
   * indexer has not yet caught up to the requested block.
   */
  getRingAt(block: number): readonly string[] | null {
    if (block > this.scannedThrough) return null;
    return computeRingAt(this.remarks, {
      proposalId: this.config.proposalId,
      atBlock: block,
      allowedRealAddresses: new Set(this.config.allowedVoters),
    });
  }

  /** Highest block we have fully scanned. */
  getScannedThrough(): number {
    return this.scannedThrough;
  }

  /** Latest known chain head (from the head subscription). */
  getHead(): number {
    return this.headBlock;
  }

  /** Number of distinct allowlist members that have announced so far. */
  getAnnouncedVoterCount(): number {
    const allowed = new Set(this.config.allowedVoters);
    const seen = new Set<string>();
    for (const r of this.remarks) {
      if (!allowed.has(r.signer)) continue;
      const parsed = parseAnnounceRemark(r.text);
      if (!parsed || parsed.proposalId !== this.config.proposalId) continue;
      seen.add(r.signer);
    }
    return seen.size;
  }

  // ─────────────────────────────────────────────────────────────

  private async start(): Promise<void> {
    const api = await this.subtensor.getApiConnection();
    if (this.destroyed) return;

    // Initial catch-up: from startBlock to whatever head is right
    // now. Subscribing first risks missing blocks if we delay; we
    // bound the gap by recording the head first, scanning up to
    // it, then enabling the subscription which fills in afterwards.
    const initialHeader = await api.rpc.chain.getHeader();
    this.headBlock = initialHeader.number.toNumber();
    this.logger.log(
      `Initial catch-up: ${this.config.proposal.startBlock}..${this.headBlock}`,
    );
    await this.catchUpTo(this.headBlock);
    if (this.destroyed) return;

    this.unsubHead = api.rpc.chain.subscribeNewHeads((header) => {
      if (this.destroyed) return;
      const n = header.number.toNumber();
      if (n > this.headBlock) {
        this.headBlock = n;
        void this.catchUpTo(n);
      }
    });
  }

  /**
   * Run a catch-up scan up to `to`. Serialized via
   * `catchUpInFlight` so overlapping head ticks don't spawn
   * duplicate workers fighting over the same range.
   */
  private async catchUpTo(to: number): Promise<void> {
    if (this.catchUpInFlight) {
      await this.catchUpInFlight;
    }
    if (this.destroyed) return;
    const from = this.scannedThrough + 1;
    if (from > to) return;

    const run = (async () => {
      try {
        const fresh = await this.scanRange(from, to);
        if (this.destroyed) return;
        // Append, then sort. The list stays small (one entry per
        // announce), so the cost is negligible.
        this.remarks.push(...fresh);
        this.remarks.sort((a, b) => a.blockNumber - b.blockNumber);
        this.scannedThrough = Math.max(this.scannedThrough, to);
        if (fresh.length > 0) {
          this.logger.log(
            `caught up to ${to}, total remarks=${this.remarks.length}, ` +
              `announced voters=${this.getAnnouncedVoterCount()}`,
          );
        }
      } finally {
        this.catchUpInFlight = null;
      }
    })();
    this.catchUpInFlight = run;
    await run;

    // If head moved further while we were scanning, do another pass.
    if (!this.destroyed && this.headBlock > to) {
      await this.catchUpTo(this.headBlock);
    }
  }

  /**
   * Parallel block fetch. Returns only `system.remark` extrinsics
   * — the live indexer doesn't need to know about anything else,
   * and filtering here keeps the in-memory list bounded by the
   * remark count rather than the total extrinsic count.
   */
  private async scanRange(from: number, to: number): Promise<RemarkLike[]> {
    const api = await this.subtensor.getApiConnection();
    const out: RemarkLike[] = [];
    let next = from;

    const CONCURRENCY = 8;
    const worker = async (): Promise<void> => {
      while (!this.destroyed) {
        const n = next++;
        if (n > to) return;
        try {
          const hash = await api.rpc.chain.getBlockHash(n);
          const signedBlock = await api.rpc.chain.getBlock(hash);
          const exs = signedBlock.block.extrinsics;
          for (const ex of exs) {
            const { section, method } = ex.method;
            if (section !== 'system' || method !== 'remark') continue;
            if (!ex.isSigned) continue;
            const arg = ex.method.args[0] as unknown as {
              toU8a: (bare: boolean) => Uint8Array;
            };
            let text: string;
            try {
              text = u8aToString(arg.toU8a(true));
            } catch {
              continue;
            }
            out.push({
              blockNumber: n,
              signer: ex.signer.toString(),
              text,
            });
          }
        } catch (err) {
          this.logger.warn(
            `block ${n} fetch failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, to - from + 1) }, () =>
        worker(),
      ),
    );
    out.sort((a, b) => a.blockNumber - b.blockNumber);
    return out;
  }
}
