import { IsArray, IsIn, IsObject, IsOptional, IsString, MinLength } from 'class-validator';
import type { AssertionSpec } from '@vision/shared';

export class CreateCollectionDto {
  @IsString()
  @MinLength(1)
  name: string;

  @IsOptional()
  @IsString()
  parentId?: string;
}

export class RenameDto {
  @IsString()
  @MinLength(1)
  name: string;
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'ALL'];

export class UpsertSavedRequestDto {
  @IsString()
  @MinLength(1)
  name: string;

  @IsOptional()
  @IsString()
  endpointId?: string;

  @IsIn(METHODS)
  method: string;

  @IsString()
  @MinLength(1)
  url: string;

  @IsOptional()
  @IsObject()
  headers?: Record<string, string>;

  @IsOptional()
  @IsString()
  body?: string | null;

  @IsOptional()
  @IsArray()
  assertions?: AssertionSpec[];
}

export class RunSavedRequestDto {
  @IsOptional()
  @IsString()
  environmentId?: string;
}
