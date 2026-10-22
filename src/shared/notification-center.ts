export const NOTIFICATION_CHANNELS = ['smtp', 'telegram', 'whatsapp-cloud', 'whatsapp-evolution'] as const;
export type NotificationChannel = typeof NOTIFICATION_CHANNELS[number];
export const NOTIFICATION_EVENTS = ['turn-completed', 'turn-failed', 'approval-pending', 'module-update', 'app-release'] as const;
export type NotificationEvent = typeof NOTIFICATION_EVENTS[number];
export interface NotificationChannelSettings {
  enabled: boolean;
  events: Record<NotificationEvent, boolean>;
  destinations: string[];
  titleTemplate: string;
  bodyTemplate: string;
  includeExcerpt: boolean;
  config: Record<string, string>;
}
export interface NotificationCenterSettings {
  channels: Record<NotificationChannel, NotificationChannelSettings>;
  throttleMinutes: number;
  batchWindowSeconds: number;
}
export interface NotificationCenterView {
  settings: NotificationCenterSettings;
  credentials: Record<NotificationChannel, boolean>;
}
