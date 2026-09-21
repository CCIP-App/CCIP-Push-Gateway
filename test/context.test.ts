import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { parseInstant } from "../src/config";
import type { Env } from "../src/types";

const keyA = "a".repeat(43);
const keyB = "b".repeat(43);
const originA = "https://admin.a.example";
const originB = "https://admin.b.example";

async function environment(): Promise<Env> {
  const digest = async (key: string) =>
    Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
  return {
    EVENT_CONFIG_JSON: JSON.stringify({
      events: {
        A: {
          organizer_name: "活動 A",
          event_ends_at: "2099-03-13T18:00:00+08:00",
        },
        B: {
          organizer_name: "活動 B",
          event_ends_at: "2020-03-13T18:00:00+08:00",
        },
      },
      keys: [
        {
          sha256: await digest(keyA),
          event_id: "A",
          allowed_origins: [originA],
          state: "active",
        },
        {
          sha256: await digest(keyB),
          event_id: "B",
          allowed_origins: [originB],
          state: "active",
        },
      ],
    }),
  } as Env;
}

function request(
  key = keyA,
  origin: string | null = originA,
  path = "/v1/context",
) {
  return new Request(`https://gateway.example${path}`, {
    headers: {
      Authorization: `Bearer ${key}`,
      ...(origin ? { Origin: origin } : {}),
    },
  });
}

describe("event context and browser boundary", () => {
  it("derives the event and shared publishing cutoff from the key", async () => {
    const response = await worker.fetch(request(), await environment());
    expect(await response.json()).toEqual({
      event_id: "A",
      organizer_name: "活動 A",
      send_until: "2099-04-12T10:00:00.000Z",
      publishing_enabled: true,
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(originA);
    expect(response.headers.get("Access-Control-Expose-Headers")).toBe(
      "Retry-After",
    );
    expect(response.headers.has("Access-Control-Allow-Credentials")).toBe(
      false,
    );
  });
  it("allows an expired event's valid key to read disabled context", async () => {
    const response = await worker.fetch(
      request(keyB, originB),
      await environment(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      event_id: "B",
      publishing_enabled: false,
    });
  });
  it("rejects a different event's origin even when globally registered", async () => {
    const response = await worker.fetch(
      request(keyA, originB),
      await environment(),
    );
    expect(response.status).toBe(403);
    expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
  });
  it.each(["missing", "revoked", "unknown"])(
    "rejects %s keys without exposing the bearer",
    async (kind) => {
      const env = await environment();
      const req = request(kind === "unknown" ? "unknown" : keyA);
      if (kind === "missing") req.headers.delete("Authorization");
      if (kind === "revoked") {
        const config = JSON.parse(env.EVENT_CONFIG_JSON);
        config.keys[0].state = "revoked";
        env.EVENT_CONFIG_JSON = JSON.stringify(config);
      }
      const response = await worker.fetch(req, env);
      expect(response.status).toBe(401);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(originA);
      expect(await response.text()).not.toContain(keyA);
    },
  );
  it("rejects missing Origin and caller-selected events", async () => {
    const env = await environment();
    expect((await worker.fetch(request(keyA, null), env)).status).toBe(403);
    expect(
      (
        await worker.fetch(
          request(keyA, originA, "/v1/context?event_id=B"),
          env,
        )
      ).status,
    ).toBe(400);
  });
  it("supports overlapping rotation without extending the event cutoff", async () => {
    const env = await environment();
    const config = JSON.parse(env.EVENT_CONFIG_JSON);
    config.keys[1].event_id = "A";
    env.EVENT_CONFIG_JSON = JSON.stringify(config);
    const first = await (await worker.fetch(request(), env)).json();
    const second = await (
      await worker.fetch(request(keyB, originB), env)
    ).json();
    expect(second).toEqual(first);
  });
  it("fails closed on missing event metadata and duplicate key digests", async () => {
    const env = await environment();
    const config = JSON.parse(env.EVENT_CONFIG_JSON);
    delete config.events.A;
    env.EVENT_CONFIG_JSON = JSON.stringify(config);
    const response = await worker.fetch(request(), env);
    expect(response.status).toBe(500);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(originA);
    config.keys.push(config.keys[0]);
    env.EVENT_CONFIG_JSON = JSON.stringify(config);
    expect((await worker.fetch(request(), env)).status).toBe(500);
  });
  it("handles preflight without a bearer and rejects unregistered methods/headers", async () => {
    const env = await environment();
    for (const [method, extra, origin, status] of [
      ["GET", "Authorization, CONTENT-TYPE", originA, 204],
      ["POST", "Authorization", originA, 403],
      ["GET", "X-Secret", originA, 403],
      ["GET", "Authorization", "https://attacker.example", 403],
    ] as const) {
      const response = await worker.fetch(
        new Request("https://gateway.example/v1/context", {
          method: "OPTIONS",
          headers: {
            Origin: origin,
            "Access-Control-Request-Method": method,
            "Access-Control-Request-Headers": extra,
          },
        }),
        env,
      );
      expect(response.status).toBe(status);
      expect(response.headers.has("Access-Control-Allow-Origin")).toBe(
        status === 204,
      );
      expect(response.headers.get("Vary")).toContain(
        "Access-Control-Request-Headers",
      );
    }
  });
  it("rejects impossible or timezone-free event dates", () => {
    for (const date of [
      "2027-02-29T00:00:00Z",
      "2028-02-30T00:00:00Z",
      "2027-03-13",
      "2027-03-13T18:00:00",
      "2027-13-01T00:00:00Z",
    ])
      expect(Number.isNaN(parseInstant(date))).toBe(true);
    expect(Number.isFinite(parseInstant("2028-02-29T00:00:00+08:00"))).toBe(
      true,
    );
  });
  it.each([
    ["invalid JSON", "valid JSON"],
    ["root", "must be an object"],
    ["events", "events must be an object"],
    ["keys", "keys must be an array"],
    ["entry", "keys[] must be an object"],
    ["sha256", "64-character lowercase hexadecimal"],
    ["duplicate", "duplicate digests"],
    ["event_id", "1-64 letters"],
    ["allowed_origins", "without paths or trailing slashes"],
    ["state", "active or revoked"],
    ["missing event", "authenticated key event_id"],
    ["organizer_name", "nonblank"],
    ["event_ends_at", "including seconds and timezone"],
  ])(
    "explains %s configuration errors without exposing values",
    async (kind, reason) => {
      const env = await environment();
      const config = JSON.parse(env.EVENT_CONFIG_JSON);
      const digest = config.keys[0].sha256;
      const secret = "private-config-value";
      if (kind === "root") env.EVENT_CONFIG_JSON = "null";
      else if (kind === "invalid JSON") env.EVENT_CONFIG_JSON = secret;
      else {
        if (kind === "events") config.events = secret;
        else if (kind === "keys") config.keys = secret;
        else if (kind === "entry") config.keys[0] = secret;
        else if (kind === "duplicate") config.keys.push(config.keys[0]);
        else if (kind === "missing event") delete config.events.A;
        else if (kind === "organizer_name")
          config.events.A.organizer_name = "\n" + secret;
        else if (kind === "event_ends_at")
          config.events.A.event_ends_at = secret;
        else
          config.keys[0][kind] =
            kind === "allowed_origins"
              ? [originA + "/"]
              : kind === "event_id"
                ? "invalid/" + secret
                : secret;
        env.EVENT_CONFIG_JSON = JSON.stringify(config);
      }
      const response = await worker.fetch(request(), env);
      expect(response.status).toBe(500);
      const body = (await response.json()) as { code: string; message: string };
      expect(Object.keys(body).sort()).toEqual(["code", "message"]);
      expect(body.code).toBe("CONFIGURATION_ERROR");
      expect(body.message).toContain("EVENT_CONFIG_JSON");
      expect(body.message).toContain(reason);
      for (const value of [
        secret,
        digest,
        keyA,
        keyB,
        originA,
        originB,
        "活動 B",
      ])
        expect(body.message).not.toContain(value);
    },
  );
});
