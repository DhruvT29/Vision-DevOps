import { Module } from '@nestjs/common';
import { AnalysisController } from './analysis.controller';
import { NestExtractorService } from './nest-extractor.service';
import { NextExtractorService } from './next-extractor.service';
import { FrontendExtractorService } from './frontend-extractor.service';
import { ScannerService } from './scanner.service';
import { StackDetectorService } from './stack-detector.service';

@Module({
  controllers: [AnalysisController],
  providers: [
    ScannerService,
    NestExtractorService,
    NextExtractorService,
    FrontendExtractorService,
    StackDetectorService,
  ],
  exports: [ScannerService, StackDetectorService],
})
export class AnalysisModule {}
