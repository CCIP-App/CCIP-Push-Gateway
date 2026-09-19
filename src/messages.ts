import {
  accessToken,
  fcmErrorCode,
  prepareAccount,
  retryDelay,
  UPSTREAM_TIMEOUT_MS,
  type FirebaseAccount,
} from "./firebase";
import { readInput } from "./input";
import {
  GatewayError,
  LOCALES,
  configurationError,
  isObject,
  type AcceptedDispatch,
  type ContentRecord,
  type Env,
  type EventContext,
  type SendResult,
  type Target,
  type UnacceptedDispatch,
} from "./types";

const OPERATION_TIMEOUT_MS = 30_000;
const MAX_IN_FLIGHT = 6;

export function topicMessage(
  record: ContentRecord,
  target: Target,
  now: number,
) {
  return {
    topic: target.topic,
    notification: { title: record.title, body: record.contents[target.locale] },
    data: {
      event_id: record.event_id,
      push_id: record.push_id,
      ...(record.uri ? { uri: record.uri } : {}),
    },
    android: {
      priority: "normal",
      ttl: `${Math.max(0, Math.floor((Date.parse(record.expires_at) - now) / 1000))}s`,
      notification: {
        channel_id: "announcements",
        sound: "default",
        default_vibrate_timings: true,
      },
    },
    apns: {
      headers: {
        "apns-priority": "5",
        "apns-push-type": "alert",
        "apns-expiration": `${Math.floor(Date.parse(record.expires_at) / 1000)}`,
      },
      payload: { aps: { sound: "default", "mutable-content": 1 } },
    },
    fcm_options: { analytics_label: record.push_id },
  };
}

export async function sendMessage(
  request: Request,
  env: Env,
  context: EventContext,
): Promise<SendResult> {
  const sendUntil = Date.parse(context.send_until);
  if (Date.now() >= sendUntil)
    throw new GatewayError(
      403,
      "EVENT_PUBLISHING_EXPIRED",
      "活動結束已滿三十天，停止發布推播。",
    );
  const input = await readInput(request);
  const account = await prepareAccount(env.FIREBASE_SERVICE_ACCOUNT);
  if (!env.PUSH_RECORDS?.prepare || !env.EVENT_RATE_LIMITER?.limit)
    return configurationError();
  const createdAt = Date.now();
  const record: ContentRecord = {
    version: 1,
    ...input,
    event_id: context.event_id,
    push_id: crypto.randomUUID(),
    title: context.organizer_name,
    created_at: new Date(createdAt).toISOString(),
    expires_at: new Date(createdAt + 3_600_000).toISOString(),
  };
  const targets: Target[] = input.roles.flatMap((role) =>
    LOCALES.map((locale) => ({
      role,
      locale,
      topic: `opass-v1.${context.event_id}.${role}.${locale}`,
    })),
  );
  for (const target of targets) {
    if (
      new TextEncoder().encode(
        JSON.stringify(topicMessage(record, target, createdAt)),
      ).byteLength > 2048
    ) {
      throw new GatewayError(
        400,
        "PAYLOAD_TOO_LARGE",
        "至少一個語系的 FCM payload 超過 2,048 bytes。",
      );
    }
  }
  if (Date.now() >= sendUntil)
    throw new GatewayError(
      403,
      "EVENT_PUBLISHING_EXPIRED",
      "活動已停止發布推播。",
    );
  if (
    !(await env.EVENT_RATE_LIMITER.limit({ key: context.event_id })).success
  ) {
    throw new GatewayError(429, "RATE_LIMITED", "此活動的發送頻率超過限制。");
  }
  try {
    const saved = await env.PUSH_RECORDS.prepare(
      "INSERT INTO push_records (push_id, event_id, created_at, content_json) VALUES (?, ?, ?, ?)",
    )
      .bind(
        record.push_id,
        record.event_id,
        record.created_at,
        JSON.stringify(record),
      )
      .run();
    if (!saved.success || saved.meta.changes !== 1)
      throw new Error("Content record not saved");
  } catch {
    throw new GatewayError(
      500,
      "CONTENT_RECORD_FAILED",
      "無法保存推播內容，尚未開始派送。",
    );
  }

  const expiresAt = Date.parse(record.expires_at);
  const deadline = createdAt + OPERATION_TIMEOUT_MS;
  const stopReason = () => {
    const now = Date.now();
    if (now >= sendUntil) return "EVENT_PUBLISHING_EXPIRED";
    if (now >= expiresAt) return "MESSAGE_EXPIRED";
    if (now >= deadline || request.signal.aborted) return "DISPATCH_ABORTED";
  };
  const signal = () =>
    AbortSignal.any([
      request.signal,
      AbortSignal.timeout(
        Math.max(
          1,
          Math.min(
            UPSTREAM_TIMEOUT_MS,
            deadline - Date.now(),
            sendUntil - Date.now(),
            expiresAt - Date.now(),
          ),
        ),
      ),
    ]);
  const accepted: AcceptedDispatch[] = [];
  const unaccepted: UnacceptedDispatch[] = [];
  let token: string | undefined;
  const stopped = stopReason();
  if (stopped) {
    unaccepted.push(
      ...targets.map((target): UnacceptedDispatch => ({
        ...target,
        outcome: "not_attempted",
        code: stopped,
      })),
    );
  } else {
    try {
      token = await accessToken(account, signal());
    } catch {
      unaccepted.push(
        ...targets.map((target): UnacceptedDispatch => ({
          ...target,
          outcome: "not_attempted",
          code: stopReason() ?? "OAUTH_FAILED",
        })),
      );
    }
  }
  if (token) {
    let cursor = 0;
    await Promise.all(
      Array.from(
        { length: Math.min(MAX_IN_FLIGHT, targets.length) },
        async () => {
          while (cursor < targets.length) {
            const target = targets[cursor++];
            const dispatchResult = await dispatch(
              target,
              record,
              account,
              token!,
              stopReason,
              signal,
              Math.min(deadline, expiresAt, sendUntil),
            );
            if ("fcm_message_id" in dispatchResult)
              accepted.push(dispatchResult);
            else unaccepted.push(dispatchResult);
          }
        },
      ),
    );
  }
  const result: SendResult =
    unaccepted.length === 0
      ? {
          push_id: record.push_id,
          event_id: record.event_id,
          status: "accepted",
          dispatches: accepted,
        }
      : {
          push_id: record.push_id,
          event_id: record.event_id,
          status: "incomplete",
          accepted,
          unaccepted,
        };
  try {
    const saved = await env.PUSH_RECORDS.prepare(
      "UPDATE push_records SET result_json = ? WHERE push_id = ? AND event_id = ?",
    )
      .bind(JSON.stringify(result), record.push_id, record.event_id)
      .run();
    if (!saved.success || saved.meta.changes !== 1)
      throw new Error("Content record missing");
  } catch {
    // FCM acceptance cannot be undone by a reporting failure.
    console.error({ code: "RESULT_RECORD_FAILED", result });
  }
  console.log({
    kind: "push_result",
    event_id: record.event_id,
    push_id: record.push_id,
    status: result.status,
    accepted: accepted.length,
    unaccepted: unaccepted.length,
  });
  if (
    accepted.length === 0 &&
    unaccepted.every(
      (item) =>
        item.outcome === "not_attempted" &&
        item.code === "EVENT_PUBLISHING_EXPIRED",
    )
  )
    throw new GatewayError(
      403,
      "EVENT_PUBLISHING_EXPIRED",
      "活動已停止發布推播，尚未開始派送。",
    );
  return result;
}

async function dispatch(
  target: Target,
  record: ContentRecord,
  account: FirebaseAccount,
  token: string,
  stopReason: () => string | undefined,
  signal: () => AbortSignal,
  deadline: number,
): Promise<AcceptedDispatch | UnacceptedDispatch> {
  let rejection: UnacceptedDispatch | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const stopped = stopReason();
    if (stopped)
      return (
        rejection ?? { ...target, outcome: "not_attempted", code: stopped }
      );
    let response: Response;
    let body: unknown;
    try {
      response = await fetch(
        `https://fcm.googleapis.com/v1/projects/${account.projectId}/messages:send`,
        {
          method: "POST",
          redirect: "manual",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            message: topicMessage(record, target, Date.now()),
          }),
          signal: signal(),
        },
      );
      body = await response.json();
    } catch {
      return {
        ...target,
        outcome: "unknown",
        code: "UPSTREAM_OUTCOME_UNKNOWN",
      };
    }
    if (response.ok) {
      if (
        isObject(body) &&
        typeof body.name === "string" &&
        body.name.length <= 512 &&
        /^projects\/[A-Za-z0-9:_-]+\/messages\/[A-Za-z0-9:._~%+-]+$/.test(
          body.name,
        )
      ) {
        return { ...target, fcm_message_id: body.name };
      }
      return {
        ...target,
        outcome: "unknown",
        code: "UPSTREAM_OUTCOME_UNKNOWN",
      };
    }
    const code = fcmErrorCode(body);
    if (!code)
      return {
        ...target,
        outcome: "unknown",
        code: "UPSTREAM_OUTCOME_UNKNOWN",
      };
    rejection = { ...target, outcome: "rejected", code };
    const retryable =
      (response.status === 500 && code === "INTERNAL") ||
      (response.status === 503 && code === "UNAVAILABLE");
    if (!retryable || attempt === 1) return rejection;
    const delay = retryDelay(response.headers.get("Retry-After"), Date.now());
    if (delay === null || Date.now() + delay >= deadline || stopReason())
      return rejection;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  return rejection!;
}
