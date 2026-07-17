import type { Recorder } from './recorder';
import type { FlightboxConfig } from './config';
import type { TriggerFireInfo } from './triggers/engine';

/**
 * The narrow surface instrumentations and triggers get: record events,
 * read config, ask the engine to fire. Nothing else leaks.
 */
export interface AgentApi {
  recorder: Recorder;
  config: FlightboxConfig;
  fire(info: TriggerFireInfo): string | null;
}
