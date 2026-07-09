import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { AnalysisModule } from './analysis/analysis.module';
import { ProjectsModule } from './projects/projects.module';
import { EnvironmentsModule } from './environments/environments.module';
import { RunnerModule } from './runner/runner.module';
import { CollectionsModule } from './collections/collections.module';
import { ScenariosModule } from './scenarios/scenarios.module';
import { HealthController } from './health.controller';

@Module({
  imports: [
    PrismaModule,
    AnalysisModule,
    ProjectsModule,
    EnvironmentsModule,
    RunnerModule,
    CollectionsModule,
    ScenariosModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
