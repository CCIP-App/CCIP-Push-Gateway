import {
  GatewayError,
  ID_PATTERN,
  LOCALES,
  isObject,
  type SendInput,
} from "./types";

function invalid(): never {
  throw new GatewayError(
    400,
    "INVALID_REQUEST",
    "請檢查角色、英文及正體中文內容及 HTTPS 連結。",
  );
}

export function validateInput(value: unknown): SendInput {
  if (
    !isObject(value) ||
    Object.keys(value).some(
      (key) => !["roles", "contents", "uri"].includes(key),
    )
  )
    return invalid();
  const { roles, contents, uri } = value;
  if (
    !Array.isArray(roles) ||
    roles.length < 1 ||
    roles.length > 8 ||
    new Set(roles).size !== roles.length ||
    !roles.every(
      (role) =>
        typeof role === "string" && ID_PATTERN.test(role) && role !== "all",
    )
  )
    return invalid();
  if (
    !isObject(contents) ||
    Object.keys(contents).length !== LOCALES.length ||
    !LOCALES.every(
      (locale) =>
        typeof contents[locale] === "string" &&
        [...contents[locale]].length >= 1 &&
        [...contents[locale]].length <= 1024,
    )
  )
    return invalid();
  if (Object.hasOwn(value, "uri")) {
    if (
      typeof uri !== "string" ||
      [...uri].length > 2048 ||
      !uri.startsWith("https://") ||
      /[\u0000-\u0020\u007f-\u009f\\]/u.test(uri)
    )
      return invalid();
    try {
      const url = new URL(uri);
      if (url.protocol !== "https:" || !url.hostname) return invalid();
    } catch {
      return invalid();
    }
  }
  return {
    roles,
    contents: contents as SendInput["contents"],
    ...(typeof uri === "string" ? { uri } : {}),
  };
}

export async function readInput(request: Request): Promise<SendInput> {
  if (
    request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !==
    "application/json"
  )
    return invalid();
  if (!request.body) return invalid();
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 65_536) {
        await reader.cancel();
        return invalid();
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return validateInput(JSON.parse(text));
  } catch {
    return invalid();
  } finally {
    reader.releaseLock();
  }
}
