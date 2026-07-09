import { Module } from '@nestjs/common';
import { AnalysisModule } from '../analysis/analysis.module';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

@Module({
  imports: [AnalysisModule],
  controllers: [ProjectsController],
  providers: [ProjectsService],
})
export class ProjectsModule {}
