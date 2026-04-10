import { Body, Controller, Get, Post } from '@nestjs/common';
import type { ProposalConfig } from '../config/faucet.config';
import { FundRequestDto } from './dto/fund-request.dto';
import { CredentialResponse, FaucetService } from './faucet.service';

@Controller('faucet')
export class FaucetController {
  constructor(private readonly faucet: FaucetService) {}

  /** Public key the UI uses to verify on-chain credentials. */
  @Get('coord')
  getCoord(): { address: string } {
    return { address: this.faucet.getCoordAddress() };
  }

  /** Allowlist of SS58 addresses that may vote on the current proposal. */
  @Get('voters')
  getVoters(): { voters: string[] } {
    return { voters: this.faucet.getAllowedVoters() };
  }

  /** Active proposal definition (id, title, description, deadline, quorum, startBlock). */
  @Get('proposal')
  getProposal(): ProposalConfig {
    return this.faucet.getProposal();
  }

  /**
   * Fund the stealth address (if needed) and return a coordinator-signed
   * credential. The UI embeds this credential in the remark it publishes
   * from the stealth wallet.
   */
  @Post('fund')
  async fund(@Body() body: FundRequestDto): Promise<CredentialResponse> {
    return this.faucet.issueCredential(body);
  }
}
