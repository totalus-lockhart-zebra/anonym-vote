import { Module } from '@nestjs/common';
import { FaucetConfig } from '../config/faucet.config';
import { FaucetController } from './faucet.controller';
import { FaucetService } from './faucet.service';
import { RingIndexerService } from './ring-indexer.service';
import { SubtensorService } from './subtensor.service';

@Module({
  controllers: [FaucetController],
  providers: [
    FaucetConfig,
    SubtensorService,
    RingIndexerService,
    FaucetService,
  ],
  exports: [FaucetConfig],
})
export class FaucetModule {}
