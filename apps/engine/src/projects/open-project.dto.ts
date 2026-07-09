import { IsString, MinLength } from 'class-validator';

export class OpenProjectDto {
  @IsString()
  @MinLength(3)
  rootPath: string;
}
