import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { DeployController } from './deploy.controller';
import { DeployService } from './deploy.service';
import { ServersController } from './servers.controller';
import { ServersService } from './servers.service';

@Module({
  // ProjectsModule provides GithubSourceService for branch-pinned deploys
  imports: [ProjectsModule],
  controllers: [ServersController, DeployController],
  providers: [ServersService, DeployService],
  // DbSchemaModule reuses ServersService for the sealed-PEM auth path
  exports: [ServersService],
})
export class DeployModule {}
