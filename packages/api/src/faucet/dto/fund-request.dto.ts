import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class FundRequestDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  proposalId!: string;

  @IsString()
  @MinLength(32)
  @MaxLength(64)
  stealthAddress!: string;

  @IsString()
  @MinLength(32)
  @MaxLength(64)
  realAddress!: string;

  @IsString()
  @Matches(/^0x[0-9a-fA-F]+$/, {
    message: 'realSignature must be a 0x-prefixed hex string',
  })
  @MinLength(4)
  @MaxLength(200)
  realSignature!: string;
}
