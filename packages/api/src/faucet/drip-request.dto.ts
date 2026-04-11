import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

const HEX32 = /^[0-9a-fA-F]{64}$/;

/**
 * Flat view of a `BlsagSignature` as it crosses the HTTP boundary.
 * Field names mirror the JSON shape that the UI's `ring-sig.ts`
 * produces, so the DTO is a one-to-one passthrough into
 * `verifyRingSig`.
 */
export class RingSignature {
  @IsString()
  @Matches(HEX32)
  challenge!: string;

  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(1024)
  @IsString({ each: true })
  @Matches(HEX32, { each: true })
  responses!: string[];

  @IsString()
  @Matches(HEX32)
  key_image!: string;
}

export class DripRequestDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  proposalId!: string;

  /**
   * SS58 address the voter wants the drip sent to. Binding it into
   * the signed message (`drip:<proposalId>:<gasAddress>`) prevents
   * the faucet from redirecting funds elsewhere — a dishonest
   * operator cannot reuse the ring sig to fund a different
   * recipient without invalidating it.
   */
  @IsString()
  @MinLength(32)
  @MaxLength(64)
  gasAddress!: string;

  /**
   * The chain block number at which the voter computed the
   * canonical ring before signing. Bound into the signed message
   * (`drip:<proposalId>:<gasAddress>:<ringBlock>`) so the faucet
   * knows which ring snapshot to verify against.
   */
  @IsInt()
  @Min(0)
  ringBlock!: number;

  @ValidateNested()
  @Type(() => RingSignature)
  ringSig!: RingSignature;
}
