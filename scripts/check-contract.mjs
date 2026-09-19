import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseDocument } from "yaml";

const document = parseDocument(
  readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8"),
  { uniqueKeys: true },
);
assert.deepEqual(
  document.errors,
  [],
  "OpenAPI must be valid YAML without duplicate keys",
);
const spec = document.toJS();
assert.equal(spec.openapi, "3.1.0");
const schemas = spec.components.schemas;
const locales = schemas.PushLocale.enum;
const request = schemas.SendMessageRequest.properties;
assert.deepEqual(locales, ["en", "zh-Hant"]);
assert.deepEqual(request.contents.required, locales);
assert.deepEqual(Object.keys(request.contents.properties), locales);
const maximumDispatches = request.roles.maxItems * locales.length;
assert.equal(
  schemas.AcceptedResponse.properties.dispatches.minItems,
  request.roles.minItems * locales.length,
);
assert.equal(
  schemas.AcceptedResponse.properties.dispatches.maxItems,
  maximumDispatches,
);
assert.equal(
  schemas.IncompleteResponse.properties.accepted.maxItems,
  maximumDispatches - 1,
);
assert.equal(
  schemas.IncompleteResponse.properties.unaccepted.maxItems,
  maximumDispatches,
);
let count = 0;
function walk(value) {
  if (value === null || typeof value !== "object") return;
  if ("$ref" in value) {
    assert.match(value.$ref, /^#\//);
    let target = spec;
    for (const segment of value.$ref.slice(2).split("/")) {
      target = target[segment.replaceAll("~1", "/").replaceAll("~0", "~")];
      assert.notEqual(target, undefined, `Unresolved reference: ${value.$ref}`);
    }
    count++;
  }
  for (const child of Object.values(value)) walk(child);
}
walk(spec);
console.log(
  `OpenAPI YAML, bilingual dispatch limits and ${count} local references are valid.`,
);
