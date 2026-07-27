import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import type { ServerSummary, ServerTestResult } from '@vision/shared';
import { CreateServerDto, UpdateServerDto } from './server.dto';
import { ServersService } from './servers.service';

@Controller('servers')
export class ServersController {
  constructor(private readonly svc: ServersService) {}

  @Get()
  list(): Promise<ServerSummary[]> {
    return this.svc.list();
  }

  @Post()
  create(@Body() dto: CreateServerDto): Promise<ServerSummary> {
    return this.svc.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateServerDto): Promise<ServerSummary> {
    return this.svc.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string): Promise<{ ok: true }> {
    return this.svc.remove(id);
  }

  @Post(':id/test')
  test(@Param('id') id: string): Promise<ServerTestResult> {
    return this.svc.test(id);
  }
}
