import { authenticate, eventContext, readRegistry } from "./config";
import { sendMessage } from "./messages";
import { GatewayError, type Env } from "./types";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const headers = new Headers({
      "Cache-Control": "no-store",
      Vary: "Origin",
    });
    const json = (body: unknown, status: number) =>
      Response.json(body, { status, headers });
    try {
      const url = new URL(request.url);
      if (!["/v1/context", "/v1/messages"].includes(url.pathname)) {
        throw new GatewayError(404, "NOT_FOUND", "找不到此 API。");
      }
      const method = url.pathname === "/v1/context" ? "GET" : "POST";
      const registry = readRegistry(env.EVENT_CONFIG_JSON);
      const origin = request.headers.get("Origin");
      const globalAllowed =
        origin !== null &&
        registry.keys.some((key) => key.allowed_origins.includes(origin));
      const allowCors = () => {
        headers.set("Access-Control-Allow-Origin", origin!);
        headers.set("Access-Control-Expose-Headers", "Retry-After");
      };
      if (request.method === "OPTIONS") {
        headers.set(
          "Vary",
          "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
        );
        const requestedHeaders = (
          request.headers.get("Access-Control-Request-Headers") ?? ""
        )
          .split(",")
          .map((header) => header.trim().toLowerCase())
          .filter(Boolean);
        if (
          !globalAllowed ||
          request.headers.get("Access-Control-Request-Method") !== method ||
          requestedHeaders.some(
            (header) => !["authorization", "content-type"].includes(header),
          )
        ) {
          throw new GatewayError(
            403,
            "ORIGIN_NOT_ALLOWED",
            "不允許此 preflight。",
          );
        }
        allowCors();
        headers.set("Access-Control-Allow-Methods", method);
        headers.set(
          "Access-Control-Allow-Headers",
          "Authorization, Content-Type",
        );
        return new Response(null, { status: 204, headers });
      }
      if (globalAllowed) allowCors();
      const key = await authenticate(
        request.headers.get("Authorization"),
        registry,
      );
      headers.delete("Access-Control-Allow-Origin");
      headers.delete("Access-Control-Expose-Headers");
      if (origin === null || !key.allowed_origins.includes(origin)) {
        throw new GatewayError(
          403,
          "ORIGIN_NOT_ALLOWED",
          "不允許此 Admin 來源。",
        );
      }
      allowCors();
      if (request.method !== method) {
        headers.set("Allow", `${method}, OPTIONS`);
        throw new GatewayError(
          405,
          "METHOD_NOT_ALLOWED",
          "不允許此 HTTP 方法。",
        );
      }
      if (url.search)
        throw new GatewayError(
          400,
          "INVALID_REQUEST",
          "此 API 不接受 query parameters。",
        );
      const context = eventContext(registry, key, Date.now());
      if (method === "GET") return json(context, 200);
      const result = await sendMessage(request, env, context);
      return json(result, result.status === "accepted" ? 200 : 502);
    } catch (error) {
      if (error instanceof GatewayError) {
        if (error.status === 429) headers.set("Retry-After", "60");
        return json({ code: error.code, message: error.message }, error.status);
      }
      console.error({ code: "INTERNAL_ERROR" });
      return json(
        { code: "INTERNAL_ERROR", message: "Gateway 無法完成此操作。" },
        500,
      );
    }
  },
} satisfies ExportedHandler<Env>;
