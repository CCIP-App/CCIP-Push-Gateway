export interface Env extends Cloudflare.Env {
  EVENT_CONFIG_JSON: string;
  FIREBASE_SERVICE_ACCOUNT: string;
}

export interface EventKey {
  sha256: string;
  event_id: string;
  allowed_origins: string[];
  state: "active" | "revoked";
}

export interface Registry {
  events: Record<string, unknown>;
  keys: EventKey[];
}

export interface EventContext {
  event_id: string;
  organizer_name: string;
  send_until: string;
  publishing_enabled: boolean;
}

export const LOCALES = ["en", "zh-Hant"] as const;
export type Locale = (typeof LOCALES)[number];

export interface SendInput {
  roles: string[];
  contents: Record<Locale, string>;
  uri?: string;
}

export interface Target {
  role: string;
  locale: Locale;
  topic: string;
}

export interface AcceptedDispatch extends Target {
  fcm_message_id: string;
}

export interface UnacceptedDispatch extends Target {
  outcome: "rejected" | "not_attempted" | "unknown";
  code: string;
}

export type SendResult = {
  push_id: string;
  event_id: string;
} & (
  | { status: "accepted"; dispatches: AcceptedDispatch[] }
  | {
      status: "incomplete";
      accepted: AcceptedDispatch[];
      unaccepted: UnacceptedDispatch[];
    }
);

export interface ContentRecord extends SendInput {
  version: 1;
  event_id: string;
  push_id: string;
  created_at: string;
  expires_at: string;
  title: string;
}

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function configurationError(): never {
  throw new GatewayError(
    500,
    "CONFIGURATION_ERROR",
    "The central Gateway configuration is invalid or unavailable.",
  );
}
