import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ApiPromise, WsProvider } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';
import type { KeyringPair } from '@polkadot/keyring/types';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { FaucetConfig } from '../config/faucet.config';

/**
 * Singleton subtensor client. Owns:
 *   - the @polkadot/api connection (created lazily, closed on shutdown)
 *   - the faucet keypair (derived from the mnemonic in env)
 *   - two operations: balance lookup and `balances.transferKeepAlive`
 *
 * In v2 the faucet has no cryptographic role beyond signing its own
 * funding extrinsics — it signs nothing that a voter later presents as
 * proof. Eligibility is carried by the ring signature the voter mints
 * locally, and this service just pays gas for one transfer per caller.
 */
@Injectable()
export class SubtensorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SubtensorService.name);
  private api: ApiPromise | null = null;
  private apiPromise: Promise<ApiPromise> | null = null;
  private faucetPair: KeyringPair | null = null;

  constructor(private readonly config: FaucetConfig) {}

  async onModuleInit(): Promise<void> {
    await cryptoWaitReady();
    const keyring = new Keyring({ type: 'sr25519' });
    this.faucetPair = keyring.addFromUri(this.config.faucetMnemonic);
    this.logger.log(`Faucet address: ${this.faucetPair.address}`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.api) {
      await this.api.disconnect();
      this.api = null;
      this.apiPromise = null;
    }
  }

  /** Public SS58 of the faucet account — shown in `/faucet/info` for transparency. */
  getFaucetAddress(): string {
    if (!this.faucetPair) {
      throw new Error('Faucet keypair not initialised yet');
    }
    return this.faucetPair.address;
  }

  /**
   * Public accessor for the singleton ApiPromise. Used by the ring
   * indexer to scan blocks on the same connection rather than opening
   * a second one.
   */
  getApiConnection(): Promise<ApiPromise> {
    return this.getApi();
  }

  /**
   * Get (and cache) the ApiPromise. We keep a single connection open for
   * the lifetime of the process — subtensor RPC endpoints are
   * rate-limited enough that reconnect churn would hurt.
   */
  private getApi(): Promise<ApiPromise> {
    if (!this.apiPromise) {
      const provider = new WsProvider(this.config.subtensorWs);
      this.apiPromise = ApiPromise.create({ provider }).then((api) => {
        this.api = api;
        this.logger.log('Subtensor API ready');
        return api;
      });
    }
    return this.apiPromise;
  }

  /** Free balance (rao) of an SS58 address. */
  async getFreeBalance(address: string): Promise<bigint> {
    const api = await this.getApi();
    interface SystemAccount {
      data: { free: { toString(): string } };
    }
    const acc = (await api.query.system.account(
      address,
    )) as unknown as SystemAccount;
    return BigInt(acc.data.free.toString());
  }

  /**
   * Send `balances.transferKeepAlive(to, amount)` from the faucet keypair.
   * Resolves with the hash of the block the extrinsic landed in.
   *
   * `transferKeepAlive` refuses to sweep the sender below existential
   * deposit, which is what we want for a long-lived faucet account.
   */
  async fundAddress(to: string, amountRao: bigint): Promise<string> {
    const api = await this.getApi();
    if (!this.faucetPair) {
      throw new Error('Faucet keypair not initialised yet');
    }
    const tx = api.tx.balances.transferKeepAlive(to, amountRao);

    return new Promise<string>((resolve, reject) => {
      let unsub: (() => void) | null = null;
      tx.signAndSend(this.faucetPair!, (result) => {
        const { status, dispatchError } = result;
        if (dispatchError) {
          unsub?.();
          if (dispatchError.isModule) {
            try {
              const decoded = api.registry.findMetaError(
                dispatchError.asModule,
              );
              reject(
                new Error(
                  `${decoded.section}.${decoded.name}: ${decoded.docs.join(' ')}`,
                ),
              );
              return;
            } catch {
              this.logger.error('Error decoding transfer error');
            }
          }
          reject(new Error(dispatchError.toString()));
          return;
        }
        if (status.isInBlock) {
          unsub?.();
          resolve(status.asInBlock.toHex());
        }
      })
        .then((u) => {
          unsub = u as unknown as () => void;
        })
        .catch(reject);
    });
  }
}
