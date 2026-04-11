import { Body, Controller, Get, Post } from '@nestjs/common';
import { DripRequestDto } from './drip-request.dto';
import { FaucetService } from './faucet.service';
import type { DripResponse, FaucetInfo } from './faucet.service';

/**
 * Public HTTP surface of the v2 faucet.
 *
 * Only two endpoints, both stateless from the caller's perspective:
 *
 *   POST /faucet/drip   — ring-sig-authenticated drip request
 *   GET  /faucet/info   — transparency / health (faucet address,
 *                         ring status, remaining budget)
 *
 * Everything else the UI used to fetch (proposal, voters, coord key,
 * votes) is gone. The UI reads the chain directly and holds the
 * proposal definition statically, so the only server-side state the
 * faucet exposes is what it itself is responsible for.
 */
@Controller('faucet')
export class FaucetController {
  constructor(private readonly faucet: FaucetService) {}

  @Post('drip')
  async drip(@Body() body: DripRequestDto): Promise<DripResponse> {
    return this.faucet.processDrip(body);
  }

  @Get('info')
  info(): FaucetInfo {
    return this.faucet.getInfo();
  }
}
