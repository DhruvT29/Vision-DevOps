import { Controller, Get } from '@nestjs/common';
import type { HealthResponse } from '@vision/shared';

@Controller('health')
export class HealthController {
  @Get()
  health(): HealthResponse {
    return { ok: true, service: 'vision-engine', version: '0.1.0' };
  }
}
