import {
  GatewayError,
  ID_PATTERN,
  configurationError,
  isObject,
  type EventContext,
  type EventKey,
  type Registry,
} from "./types";

function validOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.origin === value &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}

export function readRegistry(raw: string): Registry {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return configurationError("EVENT_CONFIG_JSON must contain valid JSON.");
  }
  if (!isObject(value))
    return configurationError("EVENT_CONFIG_JSON must be an object.");
  if (!isObject(value.events))
    return configurationError("EVENT_CONFIG_JSON.events must be an object.");
  if (!Array.isArray(value.keys))
    return configurationError("EVENT_CONFIG_JSON.keys must be an array.");
  const seen = new Set<string>();
  const keys = value.keys.map((entry: unknown): EventKey => {
    if (!isObject(entry))
      return configurationError("EVENT_CONFIG_JSON.keys[] must be an object.");
    if (
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    )
      return configurationError(
        "EVENT_CONFIG_JSON.keys[].sha256 must be a 64-character lowercase hexadecimal SHA-256 digest.",
      );
    if (seen.has(entry.sha256))
      return configurationError(
        "EVENT_CONFIG_JSON.keys[].sha256 must not contain duplicate digests.",
      );
    if (typeof entry.event_id !== "string" || !ID_PATTERN.test(entry.event_id))
      return configurationError(
        "EVENT_CONFIG_JSON.keys[].event_id must contain 1-64 letters, digits, underscores or hyphens.",
      );
    if (
      !Array.isArray(entry.allowed_origins) ||
      entry.allowed_origins.length === 0 ||
      !entry.allowed_origins.every(validOrigin)
    )
      return configurationError(
        "EVENT_CONFIG_JSON.keys[].allowed_origins must be a nonempty array of HTTPS origins (HTTP only for loopback), without paths or trailing slashes.",
      );
    if (entry.state !== "active" && entry.state !== "revoked")
      return configurationError(
        "EVENT_CONFIG_JSON.keys[].state must be active or revoked.",
      );
    seen.add(entry.sha256);
    return {
      sha256: entry.sha256,
      event_id: entry.event_id,
      allowed_origins: entry.allowed_origins,
      state: entry.state,
    };
  });
  return { events: value.events, keys };
}

export async function authenticate(
  authorization: string | null,
  registry: Registry,
): Promise<EventKey> {
  const match = /^Bearer ([^\s,]{1,1024})$/i.exec(authorization ?? "");
  if (match) {
    const bytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(match[1]),
    );
    const digest = Array.from(new Uint8Array(bytes), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const entry = registry.keys.find(
      (candidate) => candidate.sha256 === digest,
    );
    if (entry?.state === "active") return entry;
  }
  throw new GatewayError(
    401,
    "INVALID_KEY",
    "The Gateway key is missing, invalid, or revoked.",
  );
}

// Date.parse accepts impossible dates such as February 30. Check the calendar too.
export function parseInstant(value: unknown): number {
  if (typeof value !== "string") return NaN;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
      value,
    );
  if (!match) return NaN;
  const [, year, month, day] = match;
  const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (
    Number(month) < 1 ||
    Number(month) > 12 ||
    Number(day) < 1 ||
    Number(day) > days
  )
    return NaN;
  return Date.parse(value);
}

export function eventContext(
  registry: Registry,
  key: EventKey,
  now: number,
): EventContext {
  const value = Object.hasOwn(registry.events, key.event_id)
    ? registry.events[key.event_id]
    : undefined;
  if (!isObject(value))
    return configurationError(
      "EVENT_CONFIG_JSON.events must contain an object for the authenticated key event_id.",
    );
  if (
    typeof value.organizer_name !== "string" ||
    !/\S/u.test(value.organizer_name) ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value.organizer_name)
  )
    return configurationError(
      "EVENT_CONFIG_JSON.events entry organizer_name must be nonblank and contain no control characters.",
    );
  const end = parseInstant(value.event_ends_at);
  if (!Number.isFinite(end))
    return configurationError(
      "EVENT_CONFIG_JSON.events entry event_ends_at must be a valid RFC 3339 timestamp including seconds and timezone.",
    );
  const sendUntil = end + 30 * 24 * 60 * 60 * 1000;
  return {
    event_id: key.event_id,
    organizer_name: value.organizer_name,
    send_until: new Date(sendUntil).toISOString(),
    publishing_enabled: now < sendUntil,
  };
}
