import { env as runtimeEnv } from "cloudflare:workers";
import { applyD1Migrations, reset, type D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { retryDelay } from "../src/firebase";
import type { Env, SendResult } from "../src/types";

const KEY = "local-test-only-".repeat(4);
const ORIGIN = "https://admin.example";
const NOW = Date.parse("2027-03-13T10:00:00Z");
const input = {
  roles: ["audience"],
  contents: {
    en: "Lunch is ready.",
    "zh-Hant": "午餐已準備好。",
  },
};
let privatePem: string;
let publicKey: CryptoKey;
let digest: string;
let serial = 0;
let env: Env;
let sent: Record<string, any>[];
let errorLog: ReturnType<typeof vi.fn>;
let infoLog: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  publicKey = pair.publicKey;
  const pkcs8 = new Uint8Array(
    (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
  );
  privatePem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8))}\n-----END PRIVATE KEY-----\n`;
  digest = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(KEY)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
});

beforeEach(async () => {
  await reset();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  errorLog = vi.fn();
  infoLog = vi.fn();
  vi.stubGlobal("console", { ...console, log: infoLog, error: errorLog });
  sent = [];
  env = {
    ...(runtimeEnv as unknown as Env),
    EVENT_CONFIG_JSON: JSON.stringify({
      events: {
        EVENT_A: {
          organizer_name: "主辦單位",
          event_ends_at: "2027-03-13T10:00:00Z",
        },
      },
      keys: [
        {
          sha256: digest,
          event_id: "EVENT_A",
          allowed_origins: [ORIGIN],
          state: "active",
        },
      ],
    }),
    FIREBASE_SERVICE_ACCOUNT: JSON.stringify({
      type: "service_account",
      project_id: "opass-tests",
      client_email: `test-${serial++}@opass-tests.iam.gserviceaccount.com`,
      private_key: privatePem,
      token_uri: "https://oauth2.googleapis.com/token",
    }),
    EVENT_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
  };
  await applyD1Migrations(
    env.PUSH_RECORDS,
    (runtimeEnv as unknown as { TEST_MIGRATIONS: D1Migration[] })
      .TEST_MIGRATIONS,
  );
  upstream();
});

function upstream(
  respond?: (message: Record<string, any>) => Response | Promise<Response>,
) {
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    if (url === "https://oauth2.googleapis.com/token")
      return Response.json({
        access_token: "test-oauth-token",
        token_type: "Bearer",
        expires_in: 3600,
      });
    expect(url).toBe(
      "https://fcm.googleapis.com/v1/projects/opass-tests/messages:send",
    );
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer test-oauth-token",
    );
    expect(init?.signal).toBeDefined();
    const body = JSON.parse(init!.body as string);
    expect(Object.keys(body)).toEqual(["message"]);
    sent.push(body.message);
    return respond
      ? respond(body.message)
      : Response.json({ name: `projects/opass-tests/messages/${sent.length}` });
  });
}

function request(body: unknown = input) {
  return new Request("https://gateway.example/v1/messages", {
    method: "POST",
    headers: {
      Origin: ORIGIN,
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function send(body: unknown = input) {
  const response = await worker.fetch(request(body), env);
  const result = (await response.json()) as SendResult;
  return { response, result };
}

function rejected(status: number, code: string, retryAfter?: string) {
  return Response.json(
    {
      error: { status: code, message: "Never return upstream diagnostic text" },
    },
    { status, headers: retryAfter ? { "Retry-After": retryAfter } : {} },
  );
}

describe("message dispatch contract", () => {
  it("allows POST preflight without credentials and denies another method", async () => {
    for (const method of ["POST", "GET"]) {
      const response = await worker.fetch(
        new Request("https://gateway.example/v1/messages", {
          method: "OPTIONS",
          headers: {
            Origin: ORIGIN,
            "Access-Control-Request-Method": method,
            "Access-Control-Request-Headers": "Authorization, Content-Type",
          },
        }),
        env,
      );
      expect(response.status).toBe(method === "POST" ? 204 : 403);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        method === "POST" ? ORIGIN : null,
      );
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["storage", "oauth"])(
    "returns 403 when publishing expires during %s before any FCM attempt",
    async (stage) => {
      if (stage === "storage") {
        const database = env.PUSH_RECORDS;
        env.PUSH_RECORDS = {
          prepare: (query: string) => ({
            bind: (...values: unknown[]) => ({
              run: async () => {
                const saved = await database
                  .prepare(query)
                  .bind(...values)
                  .run();
                vi.mocked(Date.now).mockReturnValue(NOW + 30 * 86_400_000);
                return saved;
              },
            }),
          }),
        } as unknown as D1Database;
      } else {
        vi.mocked(fetch).mockImplementation(async () => {
          vi.mocked(Date.now).mockReturnValue(NOW + 30 * 86_400_000);
          return Response.json({
            access_token: "test-oauth-token",
            token_type: "Bearer",
            expires_in: 3600,
          });
        });
      }
      const { response, result } = await send();
      expect(response.status).toBe(403);
      expect(result).toMatchObject({ code: "EVENT_PUBLISHING_EXPIRED" });
      expect(sent).toHaveLength(0);
      expect(fetch).toHaveBeenCalledTimes(stage === "storage" ? 0 : 1);
    },
  );

  it("keeps accepted, rejected and unknown outcomes separate without retrying the operation", async () => {
    upstream((message) => {
      if (message.topic.endsWith(".staff.en"))
        throw new Error("connection lost");
      if (message.topic.endsWith(".en"))
        return Response.json({
          name: "projects/opass-tests/messages/accepted",
        });
      return rejected(400, "INVALID_ARGUMENT");
    });
    const { response, result } = await send({
      ...input,
      roles: ["audience", "staff"],
    });
    expect(response.status).toBe(502);
    expect(sent).toHaveLength(4);
    if (result.status !== "incomplete") throw new Error("Expected incomplete");
    expect(result.accepted.map((item) => item.locale)).toEqual(["en"]);
    expect(result.unaccepted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ locale: "zh-Hant", outcome: "rejected" }),
        expect.objectContaining({
          role: "staff",
          locale: "en",
          outcome: "unknown",
        }),
      ]),
    );
    expect(
      new Set(
        [...result.accepted, ...result.unaccepted].map((item) => item.topic),
      ).size,
    ).toBe(4);
  });

  it("signs OAuth JWTs with only FCM scope and preserves public content before fanout", async () => {
    upstream(async (message) => {
      const saved = await env.PUSH_RECORDS.prepare(
        "SELECT event_id, content_json, result_json FROM push_records WHERE push_id = ?",
      )
        .bind(message.data.push_id)
        .first<{
          event_id: string;
          content_json: string;
          result_json: string | null;
        }>();
      expect(saved?.event_id).toBe("EVENT_A");
      expect(saved?.result_json).toBeNull();
      expect(JSON.parse(saved!.content_json)).toMatchObject({
        ...input,
        event_id: "EVENT_A",
        title: "主辦單位",
      });
      return Response.json({
        name: `projects/opass-tests/messages/${sent.length}`,
      });
    });
    const { response, result } = await send({
      ...input,
      uri: "https://example.org/announcements",
    });
    expect(response.status).toBe(200);
    expect(result.status).toBe("accepted");
    expect(sent).toHaveLength(2);
    expect(sent.map((message) => message.topic).sort()).toEqual([
      "opass-v1.EVENT_A.audience.en",
      "opass-v1.EVENT_A.audience.zh-Hant",
    ]);
    expect(sent.map((message) => message.notification.body).sort()).toEqual(
      Object.values(input.contents).sort(),
    );
    const assertion = new URLSearchParams(
      vi.mocked(fetch).mock.calls[0][1]!.body as URLSearchParams,
    ).get("assertion")!;
    const [header, payload, signature] = assertion.split(".");
    const decode = (part: string) =>
      Uint8Array.from(
        atob(part.replaceAll("-", "+").replaceAll("_", "/")),
        (char) => char.charCodeAt(0),
      );
    expect(
      await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        publicKey,
        decode(signature),
        new TextEncoder().encode(`${header}.${payload}`),
      ),
    ).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(decode(payload)))).toMatchObject(
      {
        scope: "https://www.googleapis.com/auth/firebase.messaging",
        aud: "https://oauth2.googleapis.com/token",
        iat: NOW / 1000,
        exp: NOW / 1000 + 3600,
      },
    );
    for (const message of sent) {
      expect(message.topic).toMatch(
        /^opass-v1\.EVENT_A\.audience\.(en|zh-Hant)$/,
      );
      expect(message.notification.title).toBe("主辦單位");
      expect(message.data).toEqual({
        event_id: "EVENT_A",
        push_id: result.push_id,
        uri: "https://example.org/announcements",
      });
      expect(message.fcm_options.analytics_label).toBe(result.push_id);
      expect(message.android).toEqual({
        priority: "normal",
        ttl: "3600s",
        notification: { channel_id: "announcements", sound: "default" },
      });
      expect(message.apns).toEqual({
        headers: {
          "apns-priority": "5",
          "apns-push-type": "alert",
          "apns-expiration": `${NOW / 1000 + 3600}`,
        },
        payload: { aps: { sound: "default", "mutable-content": 1 } },
      });
    }
    const saved = await env.PUSH_RECORDS.prepare(
      "SELECT result_json FROM push_records WHERE event_id = ? AND push_id = ?",
    )
      .bind("EVENT_A", result.push_id)
      .first<string>("result_json");
    expect(JSON.parse(saved!)).toEqual(result);
  });

  it("reuses OAuth tokens but invalidates the cache when the configured credential changes", async () => {
    await send();
    await send();
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(
          ([url]) => url === "https://oauth2.googleapis.com/token",
        ),
    ).toHaveLength(1);
    const changed = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
    changed.client_email = "rotated@opass-tests.iam.gserviceaccount.com";
    env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify(changed);
    await send();
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(
          ([url]) => url === "https://oauth2.googleapis.com/token",
        ),
    ).toHaveLength(2);
  });

  it.each(["event_id", "topic", "token", "fid", "title", "expires_at"])(
    "rejects caller-supplied %s before any upstream request",
    async (field) => {
      expect(
        (await send({ ...input, [field]: "forged" })).response.status,
      ).toBe(400);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it.each([
    { ...input, roles: ["all"] },
    { ...input, roles: ["a", "a"] },
    { ...input, roles: [] },
    { ...input, roles: ["audience\nstaff"] },
    { ...input, roles: ["audience\n"] },
    { ...input, roles: Array.from({ length: 9 }, (_, i) => `role${i}`) },
    { ...input, contents: { en: "a" } },
    { ...input, contents: { "zh-Hant": "b" } },
    { ...input, contents: { ...input.contents, "zh-Hant": "" } },
    { ...input, contents: { ...input.contents, fr: "c" } },
    { ...input, contents: { ...input.contents, en: "" } },
    { ...input, contents: { ...input.contents, en: "x".repeat(1025) } },
    { ...input, uri: null },
    { ...input, uri: "http://example.com" },
    { ...input, uri: "https://" },
    { ...input, uri: "https://example.com/a b" },
    null,
    [],
  ])("rejects invalid request %#", async (body) => {
    expect((await send(body)).response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("checks all UTF-8 payloads before dispatching even the small English message", async () => {
    const { response } = await send({
      ...input,
      contents: { ...input.contents, "zh-Hant": "漢".repeat(600) },
    });
    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    expect(
      await env.PUSH_RECORDS.prepare(
        "SELECT COUNT(*) AS count FROM push_records",
      ).first<number>("count"),
    ).toBe(0);
  });
  it("counts Unicode code points and includes the centrally configured title in the byte limit", async () => {
    const config = JSON.parse(env.EVENT_CONFIG_JSON);
    config.events.EVENT_A.organizer_name = "主".repeat(700);
    env.EVENT_CONFIG_JSON = JSON.stringify(config);
    expect((await send()).response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a missing content type, malformed JSON, invalid UTF-8, and an oversized streamed body", async () => {
    for (const body of ["{", new Uint8Array([0xff]), " ".repeat(65_537)]) {
      const req = request();
      const response = await worker.fetch(
        new Request(req.url, { method: "POST", headers: req.headers, body }),
        env,
      );
      expect(response.status).toBe(400);
    }
    const req = request();
    req.headers.delete("Content-Type");
    expect((await worker.fetch(req, env)).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("limits by event rather than key and exposes a browser-readable retry delay", async () => {
    vi.mocked(env.EVENT_RATE_LIMITER.limit).mockResolvedValue({
      success: false,
    });
    const { response } = await send();
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(response.headers.get("Access-Control-Expose-Headers")).toBe(
      "Retry-After",
    );
    expect(env.EVENT_RATE_LIMITER.limit).toHaveBeenCalledWith({
      key: "EVENT_A",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["FAIL, 'storage unavailable'", "IGNORE"])(
    "never calls FCM if D1 does not save content (%s)",
    async (failure) => {
      await env.PUSH_RECORDS.prepare(
        `CREATE TRIGGER fail_content BEFORE INSERT ON push_records BEGIN SELECT RAISE(${failure}); END`,
      ).run();
      expect((await send()).response.status).toBe(500);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([200, 502])(
    "preserves HTTP %s if saving the final result fails and logs only normalized results",
    async (status) => {
      if (status === 502) upstream(() => rejected(400, "INVALID_ARGUMENT"));
      await env.PUSH_RECORDS.prepare(
        `CREATE TRIGGER fail_result BEFORE UPDATE ON push_records BEGIN SELECT RAISE(FAIL, 'secret ${KEY} ${privatePem}'); END`,
      ).run();
      const { response, result } = await send();
      const saved = await env.PUSH_RECORDS.prepare(
        "SELECT content_json, result_json FROM push_records WHERE push_id = ?",
      )
        .bind(result.push_id)
        .first<{ content_json: string; result_json: string | null }>();
      expect(response.status).toBe(status);
      expect(result.status).toBe(status === 200 ? "accepted" : "incomplete");
      expect(JSON.parse(saved!.content_json)).toMatchObject({
        event_id: "EVENT_A",
        push_id: result.push_id,
      });
      expect(saved?.result_json).toBeNull();
      expect(errorLog).toHaveBeenCalledWith({
        code: "RESULT_RECORD_FAILED",
        result,
      });
      const logs = JSON.stringify([errorLog.mock.calls, infoLog.mock.calls]);
      expect(logs).not.toContain(KEY);
      expect(logs).not.toContain("PRIVATE KEY");
      expect(logs).not.toContain("test-oauth-token");
    },
  );

  it("reports a missing result-update target without recreating content or resending", async () => {
    upstream(async () => {
      await env.PUSH_RECORDS.prepare("DELETE FROM push_records").run();
      return Response.json({ name: "projects/opass-tests/messages/accepted" });
    });
    const { response, result } = await send();
    expect(response.status).toBe(200);
    expect(sent).toHaveLength(2);
    expect(errorLog).toHaveBeenCalledWith({
      code: "RESULT_RECORD_FAILED",
      result,
    });
    expect(
      await env.PUSH_RECORDS.prepare(
        "SELECT COUNT(*) AS count FROM push_records",
      ).first<number>("count"),
    ).toBe(0);
  });

  it("reports OAuth failure as not attempted, preserving every role-locale combination", async () => {
    vi.mocked(fetch).mockResolvedValue(rejected(401, "UNAUTHENTICATED"));
    const { response, result } = await send();
    expect(response.status).toBe(502);
    expect(result).toMatchObject({
      status: "incomplete",
      accepted: [],
      unaccepted: input.roles.flatMap((role) =>
        ["en", "zh-Hant"].map((locale) => ({
          role,
          locale,
          outcome: "not_attempted",
          code: "OAUTH_FAILED",
        })),
      ),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("fails closed on malformed service-account configuration without following token_uri", async () => {
    const config = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
    config.token_uri = "https://attacker.example/token";
    env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify(config);
    expect((await send()).response.status).toBe(500);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps no more than six FCM requests in flight for eight roles", async () => {
    let inFlight = 0,
      maximum = 0;
    upstream(async () => {
      maximum = Math.max(maximum, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight--;
      return Response.json({
        name: `projects/opass-tests/messages/${crypto.randomUUID()}`,
      });
    });
    const { response, result } = await send({
      ...input,
      roles: Array.from({ length: 8 }, (_, i) => `r${i}`),
    });
    expect(response.status).toBe(200);
    expect(maximum).toBe(6);
    if (result.status === "accepted")
      expect(result.dispatches).toHaveLength(16);
    expect(sent).toHaveLength(16);
  });

  it.each([
    [400, "INVALID_ARGUMENT"],
    [401, "UNAUTHENTICATED"],
    [403, "PERMISSION_DENIED"],
    [429, "QUOTA_EXCEEDED"],
    [400, "INTERNAL"],
    [500, "UNAVAILABLE"],
    [503, "INTERNAL"],
  ] as const)(
    "does not retry permanent or quota failure %s",
    async (status, code) => {
      upstream(() => rejected(status, code));
      const { response, result } = await send();
      expect(response.status).toBe(502);
      expect(sent).toHaveLength(2);
      if (result.status === "incomplete")
        expect(
          result.unaccepted.every(
            (item) => item.outcome === "rejected" && item.code === code,
          ),
        ).toBe(true);
    },
  );

  it("does not retry transport failures or fabricate upstream acceptance", async () => {
    upstream(() => {
      throw new Error(`unknown transport ${KEY}`);
    });
    const { response, result } = await send();
    expect(response.status).toBe(502);
    expect(sent).toHaveLength(2);
    if (result.status === "incomplete")
      expect(
        result.unaccepted.every((item) => item.outcome === "unknown"),
      ).toBe(true);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(KEY);
  });
  it.each([
    new Response("not JSON", { status: 503 }),
    Response.json({}),
    Response.json({ error: { status: "SECRET_DIAGNOSTIC" } }, { status: 500 }),
  ])(
    "treats unclassifiable upstream responses as unknown",
    async (response) => {
      upstream(() => response.clone());
      const { result } = await send();
      if (result.status === "incomplete")
        expect(
          result.unaccepted.every((item) => item.outcome === "unknown"),
        ).toBe(true);
      else throw new Error("Expected incomplete");
      expect(sent).toHaveLength(2);
    },
  );

  it.each([
    [500, "INTERNAL"],
    [503, "UNAVAILABLE"],
  ] as const)(
    "retries explicit %s once while retaining one push ID and expiry",
    async (status, code) => {
      const attempts = new Map<string, number>();
      upstream((message) => {
        const attempt = (attempts.get(message.topic) ?? 0) + 1;
        attempts.set(message.topic, attempt);
        vi.mocked(Date.now).mockReturnValue(NOW + 2000);
        return attempt === 1
          ? rejected(status, code)
          : Response.json({
              name: `projects/opass-tests/messages/${sent.length}`,
            });
      });
      const { response, result } = await send();
      expect(response.status).toBe(200);
      expect(sent).toHaveLength(4);
      expect(
        sent.slice(2).every((message) => message.android.ttl === "3598s"),
      ).toBe(true);
      expect(
        new Set(sent.map((message) => message.fcm_options.analytics_label)),
      ).toEqual(new Set([result.push_id]));
      expect(
        new Set(sent.map((message) => message.apns.headers["apns-expiration"]))
          .size,
      ).toBe(1);
    },
  );

  it("stops after the second rejection and never counts retries as extra dispatches", async () => {
    upstream(() => rejected(500, "INTERNAL"));
    const { result } = await send();
    expect(sent).toHaveLength(4);
    if (result.status === "incomplete")
      expect(result.unaccepted).toHaveLength(2);
    else throw new Error("Expected incomplete");
  });

  it("keeps retry transport failures unknown instead of restoring the first rejection", async () => {
    const attempts = new Set<string>();
    upstream((message) => {
      if (attempts.has(message.topic)) throw new Error("connection reset");
      attempts.add(message.topic);
      return rejected(503, "UNAVAILABLE");
    });
    const { result } = await send();
    expect(sent).toHaveLength(4);
    if (result.status === "incomplete")
      expect(
        result.unaccepted.every((item) => item.outcome === "unknown"),
      ).toBe(true);
  });

  it("honors long Retry-After without retrying early or scheduling recovery", async () => {
    upstream(() => rejected(503, "UNAVAILABLE", "60"));
    const { result } = await send();
    expect(sent).toHaveLength(2);
    if (result.status === "incomplete")
      expect(
        result.unaccepted.every((item) => item.outcome === "rejected"),
      ).toBe(true);
    expect(retryDelay("10", NOW)).toBe(10_000);
    expect(retryDelay(new Date(NOW + 20_000).toUTCString(), NOW)).toBe(20_000);
    expect(retryDelay("malformed", NOW)).toBeNull();
    expect(retryDelay("1.5", NOW)).toBeNull();
  });

  it("rejects publishing at the exact cutoff before any upstream call", async () => {
    vi.mocked(Date.now).mockReturnValue(NOW + 30 * 86_400_000);
    expect((await send()).response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [30 * 86_400_000, "EVENT_PUBLISHING_EXPIRED"],
    [3_600_000, "MESSAGE_EXPIRED"],
    [30_000, "DISPATCH_ABORTED"],
  ] as const)(
    "reports unsent targets honestly when the operation stops (%s)",
    async (advance, code) => {
      upstream(() => {
        vi.mocked(Date.now).mockReturnValue(NOW + advance);
        return Response.json({
          name: "projects/opass-tests/messages/accepted-before-cutoff",
        });
      });
      const { response, result } = await send({
        ...input,
        roles: ["audience", "staff", "speaker"],
      });
      expect(response.status).toBe(502);
      if (result.status === "incomplete") {
        expect(result.accepted.length + result.unaccepted.length).toBe(6);
        expect(result.accepted.length).toBe(1);
        expect(
          result.unaccepted.every(
            (item) => item.outcome === "not_attempted" && item.code === code,
          ),
        ).toBe(true);
      } else throw new Error("Expected incomplete");
    },
  );

  it("retains a known rejection if publishing expires before a retry", async () => {
    upstream(() => {
      vi.mocked(Date.now).mockReturnValue(NOW + 30 * 86_400_000);
      return rejected(503, "UNAVAILABLE");
    });
    const { result } = await send();
    expect(sent).toHaveLength(1);
    if (result.status === "incomplete") {
      expect(
        result.unaccepted.filter((item) => item.outcome === "rejected"),
      ).toHaveLength(1);
      expect(
        result.unaccepted.filter((item) => item.outcome === "not_attempted"),
      ).toHaveLength(1);
    }
  });
});
