/** Managed applications remain independent; Marks only orchestrates their existing interfaces. */
export type MarksModuleId = 'cli-proxy-api';
export type MarksModuleAction = 'install' | 'start' | 'stop' | 'restart' | 'enable' | 'disable' | 'open';
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
}
