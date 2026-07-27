import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class DeployStepDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(20_000)
  command!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  confirmBefore?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  confirmOnFailure?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class DeployUploadDto {
  @IsString()
  @MinLength(1)
  @MaxLength(1_000)
  localDir!: string;

  @IsArray()
  @IsString({ each: true })
  excludeDirs!: string[];

  @IsArray()
  @IsString({ each: true })
  excludeFiles!: string[];

  @IsString()
  @MinLength(1)
  @MaxLength(1_000)
  remoteZipPath!: string;
}

// One DTO for create + update: create validates required fields in the
// service; null clears an optional field (upload, healthUrl) on update.
export class UpsertDeployTargetDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  serverId?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(1_000)
  workingDir?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  preflight?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => DeployUploadDto)
  upload?: DeployUploadDto | null;

  @IsOptional()
  @IsString()
  @MaxLength(250)
  branch?: string | null;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DeployStepDto)
  steps?: DeployStepDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DeployStepDto)
  localPre?: DeployStepDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DeployStepDto)
  localPost?: DeployStepDto[];

  @IsOptional()
  @IsString()
  @MaxLength(1_000)
  scriptPath?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  healthUrl?: string | null;
}

/** Body for POST /deployments/:id/respond — the answer to a pending prompt. */
export class RespondDeployDto {
  @IsInt()
  @Min(0)
  stepIndex!: number;

  @IsBoolean()
  answer!: boolean;
}

/** Body for POST /deploy/parse-script — a path on this machine or raw contents. */
export class ParseScriptDto {
  @IsOptional()
  @IsString()
  @MaxLength(1_000)
  path?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2_000_000)
  content?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  fileName?: string;
}
