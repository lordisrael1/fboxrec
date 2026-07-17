import type { IncidentMeta } from '@flightbox/format';

export interface DeliveryResult {
  ok: boolean;
  /** Where the incident landed (s3 uri, dir path, url) — for the log line. */
  location?: string;
  /** The one-click magic link, when the sink can mint one. */
  viewerUrl?: string;
  detail?: string;
}

export interface Sink {
  name: string;
  deliver(filePath: string, meta: IncidentMeta): Promise<DeliveryResult>;
}
