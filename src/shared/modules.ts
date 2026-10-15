/** Managed applications remain independent; Marks only orchestrates their existing interfaces. */
import type { MarksModuleSource } from './module-sources.js';

export type MarksModuleId = 'cli-proxy-api';
export type MarksModuleAction = 'install' | 'update' | 'start' | 'stop' | 'restart' | 'enable' | 'disable' | 'open';
export interface MarksModuleState {
  id: MarksModuleId;
  name: string;
  description: string;
  installed: boolean;
  enabled: boolean;
  running: boolean;
  supported: boolean;
  /** Console identity validated and the local service running. */
  consoleAvailable?: boolean;
  managementUrl: string;
  detail: string;
  /** Acquisition metadata only. Never implies automatic download or execution. */
  source: MarksModuleSource;
}
