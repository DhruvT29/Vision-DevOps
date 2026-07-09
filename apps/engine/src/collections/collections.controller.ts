import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { CollectionsService } from './collections.service';
import {
  CreateCollectionDto,
  RenameDto,
  RunSavedRequestDto,
  UpsertSavedRequestDto,
} from './collections.dto';

@Controller()
export class CollectionsController {
  constructor(private readonly svc: CollectionsService) {}

  @Get('projects/:projectId/collections')
  payload(@Param('projectId') projectId: string) {
    return this.svc.payload(projectId);
  }

  @Post('projects/:projectId/collections')
  create(@Param('projectId') projectId: string, @Body() dto: CreateCollectionDto) {
    return this.svc.createCollection(projectId, dto);
  }

  @Patch('collections/:id')
  rename(@Param('id') id: string, @Body() dto: RenameDto) {
    return this.svc.renameCollection(id, dto.name);
  }

  @Delete('collections/:id')
  @HttpCode(204)
  remove(@Param('id') id: string) {
    return this.svc.deleteCollection(id);
  }

  @Post('collections/:id/requests')
  createRequest(@Param('id') collectionId: string, @Body() dto: UpsertSavedRequestDto) {
    return this.svc.createRequest(collectionId, dto);
  }

  @Patch('requests/:id')
  updateRequest(@Param('id') id: string, @Body() dto: UpsertSavedRequestDto) {
    return this.svc.updateRequest(id, dto);
  }

  @Delete('requests/:id')
  @HttpCode(204)
  removeRequest(@Param('id') id: string) {
    return this.svc.deleteRequest(id);
  }

  @Post('requests/:id/run')
  runRequest(@Param('id') id: string, @Body() dto: RunSavedRequestDto) {
    return this.svc.runRequest(id, dto.environmentId);
  }
}
