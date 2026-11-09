export const NOTIFICATION_CHANNELS = ['smtp', 'telegram', 'whatsapp-web', 'whatsapp-cloud', 'whatsapp-evolution'] as const;
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

/** The only details about WhatsApp setup that may cross IPC. Never include OS/provider messages. */
export const WHATSAPP_SETUP_ISSUES = [
  'storage_unavailable', 'session_invalid', 'runtime_unavailable', 'initialization_failed',
  'connection_failed', 'qr_timeout', 'qr_render_failed', 'unknown'
] as const;
export type WhatsAppSetupIssue = typeof WHATSAPP_SETUP_ISSUES[number];

/**
 * Non-secret, machine-readable reasons a channel test or send failed. The main process classifies
 * transport errors into these codes; the renderer translates each one. Never add provider text,
 * credentials, tokens or message bodies to a failure.
 */
export const NOTIFICATION_FAILURE_CODES = [
  'config_incomplete', 'credential_missing', 'credential_unavailable',
  'dns_failed', 'connect_timeout', 'connection_refused', 'network_unreachable', 'connection_closed', 'server_timeout', 'whatsapp_disconnected',
  'tls_untrusted', 'tls_hostname_mismatch', 'starttls_unavailable',
  'auth_failed', 'sender_rejected', 'recipient_rejected', 'server_error',
  'invalid_token', 'unknown_destination', 'rate_limited', 'http_client_error', 'http_server_error',
  'unknown'
] as const;
export type NotificationFailureCode = typeof NOTIFICATION_FAILURE_CODES[number];
/** The certificate a TLS server presented: public data only, shown so the user can decide whether to pin it. */
export interface PresentedCertificate { fingerprint256: string; names: string[]; selfSigned: boolean; validTo?: string }
export interface NotificationFailure {
  code: NotificationFailureCode;
  channel?: NotificationChannel;
  /** Three-digit SMTP reply code of the refused command. */
  smtpCode?: number;
  httpStatus?: number;
  /** The resolved address is in Cloudflare's published proxy ranges, which carry only HTTP(S). */
  cloudflare?: boolean;
  /** The channel has a pinned fingerprint and the server presented a different certificate. */
  pinned?: boolean;
  certificate?: PresentedCertificate;
}
/** Node's `fingerprint256` form: 32 upper-case hex bytes separated by colons. */
export const CERTIFICATE_FINGERPRINT = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;
