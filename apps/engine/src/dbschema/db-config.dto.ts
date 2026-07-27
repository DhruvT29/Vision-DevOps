import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import type { DbEngine } from '@vision/shared';

/**
 * Per-target DB connection override. Every field is optional — blanks fall back
 * to auto-discovery from the app's .env. `password` is request-only; it is
 * sealed at rest and never echoed back.
 */
export class DbConnectionConfigDto {
  @IsOptional()
  @IsIn(['postgres', 'mysql'])
  engine?: DbEngine;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  connectionUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  host?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  database?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  user?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1_000)
  password?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1_000)
  envPath?: string;
}
