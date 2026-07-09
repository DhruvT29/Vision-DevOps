import { IsIn, IsObject, IsOptional, IsString, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class EnvironmentAuthDto {
  @IsIn(['none', 'bearer'])
  type: 'none' | 'bearer';

  @IsOptional()
  @IsString()
  token?: string;

  @IsOptional()
  @IsString()
  header?: string;
}

export class UpsertEnvironmentDto {
  @IsString()
  @MinLength(1)
  name: string;

  @IsString()
  baseUrl: string;

  @IsOptional()
  @IsObject()
  variables?: Record<string, string>;

  @IsOptional()
  @ValidateNested()
  @Type(() => EnvironmentAuthDto)
  auth?: EnvironmentAuthDto;
}
