import { Module } from '@nestjs/common';
import { DeployModule } from '../deploy/deploy.module';
import { DbSchemaController } from './db-schema.controller';
import { DbSchemaService } from './db-schema.service';

@Module({
  // DeployModule provides ServersService (the sealed-PEM auth path)
  imports: [DeployModule],
  controllers: [DbSchemaController],
  providers: [DbSchemaService],
})
export class DbSchemaModule {}
