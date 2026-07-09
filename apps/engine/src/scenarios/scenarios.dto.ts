import { IsArray, IsOptional, IsString, MinLength } from 'class-validator';
import type { VariableExtraction } from '@vision/shared';

export class CreateScenarioDto {
  @IsString()
  @MinLength(1)
  name: string;
}

export class AddStepDto {
  @IsString()
  savedRequestId: string;

  @IsOptional()
  @IsArray()
  extractions?: VariableExtraction[];
}

export class RunScenarioDto {
  @IsOptional()
  @IsString()
  environmentId?: string;
}
