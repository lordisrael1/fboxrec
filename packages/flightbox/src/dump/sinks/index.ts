import type { SinkConfig } from '../../config';
import type { Sink } from './types';
import { createDiskSink } from './disk';
import { createS3Sink } from './s3';
import { createHttpSink } from './http';

export type { Sink, DeliveryResult } from './types';

export function createSink(cfg: SinkConfig, defaultViewerOrigin: string): Sink {
  switch (cfg.type) {
    case 'disk':
      return createDiskSink(cfg);
    case 's3':
      return createS3Sink(cfg, defaultViewerOrigin);
    case 'http':
      return createHttpSink(cfg);
  }
}
