import { IsIn, IsObject, IsOptional, IsString, MinLength } from 'class-validator';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'ALL'] as const;

export class RunRequestDto {
  @IsString()
  projectId: string;

  @IsOptional()
  @IsString()
  environmentId?: string;

  @IsOptional()
  @IsString()
  endpointId?: string;

  @IsIn(METHODS as unknown as string[])
  method: (typeof METHODS)[number];

  @IsString()
  @MinLength(1)
  url: string;

  @IsOptional()
  @IsObject()
  headers?: Record<string, string>;

  @IsOptional()
  @IsString()
  body?: string | null;
}
