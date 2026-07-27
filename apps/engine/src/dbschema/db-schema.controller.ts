import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import type { DbConnectionInfo, DbSchemaResult } from '@vision/shared';
import { DbConnectionConfigDto } from './db-config.dto';
import { DbSchemaService } from './db-schema.service';

@Controller('deploy-targets')
export class DbSchemaController {
  constructor(private readonly svc: DbSchemaService) {}

  @Get(':id/db-connection')
  connection(@Param('id') id: string): Promise<DbConnectionInfo> {
    return this.svc.getConnectionInfo(id);
  }

  @Put(':id/db-connection')
  saveConnection(
    @Param('id') id: string,
    @Body() dto: DbConnectionConfigDto,
  ): Promise<DbConnectionInfo> {
    return this.svc.saveConnection(id, dto);
  }

  @Get(':id/db-schema')
  cached(@Param('id') id: string): Promise<DbSchemaResult | null> {
    return this.svc.getCached(id);
  }

  @Post(':id/db-schema/fetch')
  fetch(@Param('id') id: string): Promise<DbSchemaResult> {
    return this.svc.fetchSchema(id);
  }
}
