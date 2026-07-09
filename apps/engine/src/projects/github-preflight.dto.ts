import { IsOptional, IsString, MinLength } from 'class-validator';

export class GithubPreflightDto {
  @IsString()
  @MinLength(3)
  repoUrl: string;

  @IsOptional()
  @IsString()
  token?: string;
}
