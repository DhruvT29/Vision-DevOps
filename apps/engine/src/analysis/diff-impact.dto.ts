import { IsOptional, IsString, MaxLength } from 'class-validator';

export class DiffImpactDto {
  /** git ref to diff against; defaults to HEAD (uncommitted changes) */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  base?: string;
}
