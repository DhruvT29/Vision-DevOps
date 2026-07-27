import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class CreateServerDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  host!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  username!: string;

  // PEM contents — request-only; sealed immediately, never echoed back
  @IsString()
  @MinLength(1)
  @MaxLength(64_000)
  privateKey!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1_000)
  passphrase?: string;
}

export class UpdateServerDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  host?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  username?: string;

  // omitted/blank = keep the existing sealed key
  @IsOptional()
  @IsString()
  @MaxLength(64_000)
  privateKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1_000)
  passphrase?: string;
}
