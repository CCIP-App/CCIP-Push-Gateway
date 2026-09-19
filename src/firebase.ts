import { configurationError, isObject } from "./types";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
export const UPSTREAM_TIMEOUT_MS = 10_000;

export interface FirebaseAccount {
  projectId: string;
  email: string;
  key: CryptoKey;
  token?: { value: string; expiresAt: number };
}

// One centrally configured service account per Worker. Rotation changes the cache key.
let cached: { source: string; account: FirebaseAccount } | undefined;

export async function prepareAccount(source: string): Promise<FirebaseAccount> {
  if (cached && cached.source === source) return cached.account;
  try {
    const value: unknown = JSON.parse(source);
    if (
      !isObject(value) ||
      value.type !== "service_account" ||
      typeof value.project_id !== "string" ||
      !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value.project_id) ||
      typeof value.client_email !== "string" ||
      !/^[^\s@]+@[^\s@]+\.gserviceaccount\.com$/.test(value.client_email) ||
      typeof value.private_key !== "string" ||
      (value.token_uri !== undefined && value.token_uri !== TOKEN_URL)
    )
      return configurationError();
    const pem =
      /^-----BEGIN PRIVATE KEY-----\s+([A-Za-z0-9+/=\r\n]+)\s+-----END PRIVATE KEY-----\s*$/.exec(
        value.private_key,
      );
    if (!pem) return configurationError();
    const bytes = Uint8Array.from(atob(pem[1].replace(/\s/g, "")), (char) =>
      char.charCodeAt(0),
    );
    const key = await crypto.subtle.importKey(
      "pkcs8",
      bytes,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    if ((key.algorithm as { modulusLength: number }).modulusLength < 2048)
      return configurationError();
    const account = {
      projectId: value.project_id,
      email: value.client_email,
      key,
    };
    cached = { source, account };
    return account;
  } catch {
    return configurationError();
  }
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export async function accessToken(
  account: FirebaseAccount,
  signal: AbortSignal,
): Promise<string> {
  const now = Date.now();
  if (account.token && account.token.expiresAt > now + 60_000)
    return account.token.value;
  const encode = (value: unknown) =>
    base64url(new TextEncoder().encode(JSON.stringify(value)));
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: account.email, scope: SCOPE, aud: TOKEN_URL, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 3600 })}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    account.key,
    new TextEncoder().encode(unsigned),
  );
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${base64url(new Uint8Array(signature))}`,
    }),
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("OAUTH_FAILED");
  }
  const value: unknown = await response.json();
  if (
    !isObject(value) ||
    typeof value.access_token !== "string" ||
    !/^[^\s]{1,16384}$/.test(value.access_token) ||
    typeof value.expires_in !== "number" ||
    !Number.isFinite(value.expires_in) ||
    value.expires_in <= 0 ||
    value.token_type !== "Bearer"
  )
    throw new Error("OAUTH_FAILED");
  account.token = {
    value: value.access_token,
    expiresAt: now + Math.min(value.expires_in, 3600) * 1000,
  };
  return account.token.value;
}

const FCM_CODES = new Set([
  "INVALID_ARGUMENT",
  "UNREGISTERED",
  "SENDER_ID_MISMATCH",
  "QUOTA_EXCEEDED",
  "APNS_AUTH_ERROR",
  "THIRD_PARTY_AUTH_ERROR",
  "UNAVAILABLE",
  "INTERNAL",
  "PERMISSION_DENIED",
  "UNAUTHENTICATED",
  "NOT_FOUND",
  "RESOURCE_EXHAUSTED",
  "DEADLINE_EXCEEDED",
]);

export function fcmError(value: unknown): string | undefined {
  if (!isObject(value) || !isObject(value.error)) return;
  const details = value.error.details;
  if (Array.isArray(details)) {
    const fcm = details.find(
      (detail: unknown) =>
        isObject(detail) &&
        detail["@type"] ===
          "type.googleapis.com/google.firebase.fcm.v1.FcmError",
    );
    if (
      isObject(fcm) &&
      typeof fcm.errorCode === "string" &&
      FCM_CODES.has(fcm.errorCode)
    )
      return fcm.errorCode;
  }
  if (
    typeof value.error.status === "string" &&
    FCM_CODES.has(value.error.status)
  )
    return value.error.status;
}

export function retryDelay(header: string | null, now: number): number | null {
  const backoff = 1000 + Math.floor(Math.random() * 250);
  if (header === null) return backoff;
  if (/^\d+$/.test(header)) {
    const delay = Number(header) * 1000;
    return Number.isFinite(delay) ? Math.max(backoff, delay) : null;
  }
  const date = Date.parse(header);
  return Number.isFinite(date) && new Date(date).toUTCString() === header
    ? Math.max(backoff, date - now)
    : null;
}
