import { IsOptional, IsString, MaxLength } from 'class-validator';

export class DbDiffDto {
  /** raw SQL to analyze (pasted migration) */
  @IsOptional()
  @IsString()
  @MaxLength(2_000_000)
  sql?: string;

  /** project-root-relative path of a migration file to analyze instead */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  migrationPath?: string;
}
