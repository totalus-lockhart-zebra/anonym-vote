import { Module } from '@nestjs/common';
import { FaucetConfig } from '../config/faucet.config';
import { FaucetController } from './faucet.controller';
import { FaucetService } from './faucet.service';
import { SubtensorService } from './subtensor.service';

@Module({
  controllers: [FaucetController],
  providers: [FaucetConfig, SubtensorService, FaucetService],
  exports: [FaucetConfig],
})
export class FaucetModule {}
