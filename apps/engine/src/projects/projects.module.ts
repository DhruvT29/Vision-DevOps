import { Module } from '@nestjs/common';
import { AnalysisModule } from '../analysis/analysis.module';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { GithubSourceService } from './github-source.service';

@Module({
  imports: [AnalysisModule],
  controllers: [ProjectsController],
  providers: [ProjectsService, GithubSourceService],
})
export class ProjectsModule {}
