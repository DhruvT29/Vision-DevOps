import { IsOptional, IsString, MinLength } from 'class-validator';

export class OpenGithubDto {
  @IsString()
  @MinLength(3)
  repoUrl: string;

  @IsOptional()
  @IsString()
  branch?: string;

  /** Optional PAT override; system credentials are tried first when omitted. */
  @IsOptional()
  @IsString()
  token?: string;
}
