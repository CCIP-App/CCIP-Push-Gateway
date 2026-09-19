import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const locales = ["en", "zh-Hant"];
const id = /^[A-Za-z0-9_-]{1,64}$/;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function instant(value) {
  assert(
    typeof value === "string" &&
      /^\d{4}-\d\d-\d\dT([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/.test(
        value,
      ),
    "時間必須包含時區",
  );
  const time = Date.parse(value);
  assert(Number.isFinite(time), "時間不合法");
  const day = value.slice(0, 10);
  assert(
    new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day,
    "日期不存在",
  );
  return time;
}

function cell(value) {
  let text = String(value);
  // Quote CSV delimiters and neutralize formulas, including leading whitespace.
  if (/^[\t\r\n]|^\s*[=+\-@＝＋－＠]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export async function exportContent({ input, event, output, cutoff }) {
  assert(typeof event === "string" && id.test(event), "活動 ID 不合法");
  const cutoffTime = instant(cutoff);
  const exportedAt = new Date().toISOString();
  const records = [];
  const seen = new Set();
  const queries = JSON.parse(await readFile(input, "utf8"));
  assert(
    Array.isArray(queries) &&
      queries.length === 1 &&
      queries[0]?.success === true &&
      Array.isArray(queries[0].results),
    "輸入必須是單一成功 D1 查詢的 Wrangler JSON",
  );
  const sourceRows = queries[0].results;
  for (const row of sourceRows) {
    assert(
      row?.source_count === sourceRows.length,
      "D1 來源筆數不符，請重新下載完整查詢結果",
    );
    assert(typeof row.content_json === "string", "缺少 D1 內容紀錄");
    const record = JSON.parse(row.content_json);
    assert(
      record &&
        row.event_id === record.event_id &&
        row.push_id === record.push_id &&
        row.created_at === record.created_at,
      "D1 索引欄位與內容紀錄不符",
    );
    assert(record.event_id === event, "D1 查詢包含其他活動");
    assert(
      record.version === 1 &&
        typeof record.push_id === "string" &&
        uuid.test(record.push_id),
      "不支援的內容紀錄",
    );
    const createdAt = instant(record.created_at);
    assert(
      record.created_at === new Date(createdAt).toISOString(),
      "D1 建立時間必須是含毫秒的標準 UTC 格式",
    );
    assert(
      instant(record.expires_at) - createdAt === 3_600_000,
      "訊息期限不合法",
    );
    assert(typeof record.title === "string" && record.title.trim(), "缺少標題");
    assert(
      Array.isArray(record.roles) &&
        record.roles.length >= 1 &&
        record.roles.length <= 8 &&
        new Set(record.roles).size === record.roles.length &&
        record.roles.every(
          (role) => typeof role === "string" && id.test(role) && role !== "all",
        ),
      "角色資料不合法",
    );
    assert(
      record.contents &&
        Object.keys(record.contents).length === locales.length &&
        locales.every(
          (locale) =>
            typeof record.contents[locale] === "string" &&
            [...record.contents[locale]].length >= 1 &&
            [...record.contents[locale]].length <= 1024,
        ),
      "缺少或無效的英文或正體中文內容",
    );
    assert(
      record.uri === undefined ||
        (typeof record.uri === "string" &&
          record.uri.startsWith("https://") &&
          new URL(record.uri).protocol === "https:"),
      "URI 不合法",
    );
    assert(createdAt <= cutoffTime, "D1 查詢包含截止時間後的內容");
    assert(!seen.has(record.push_id), "重複的 push_id，請檢查來源查詢");
    seen.add(record.push_id);
    records.push(record);
  }
  assert(records.length > 0, "此活動在截止時間內沒有內容紀錄");
  records.sort(
    (a, b) =>
      Date.parse(a.created_at) - Date.parse(b.created_at) ||
      a.push_id.localeCompare(b.push_id),
  );
  const rows = [
    [
      "event_id",
      "push_id",
      "created_at",
      "expires_at",
      "roles",
      "locale",
      "title",
      "body",
      "uri",
      "source",
      "cutoff_at",
      "exported_at",
    ],
  ];
  for (const record of records) {
    for (const locale of locales) {
      rows.push([
        event,
        record.push_id,
        record.created_at,
        record.expires_at,
        record.roles.join(";"),
        locale,
        record.title,
        record.contents[locale],
        record.uri ?? "",
        "gateway_content_record",
        new Date(cutoffTime).toISOString(),
        exportedAt,
      ]);
    }
  }
  // A fresh directory prevents mixing a new export with an older or different event.
  await mkdir(output);
  await writeFile(
    join(output, "content.csv"),
    "\uFEFF" + rows.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n",
  );
  await writeFile(
    join(output, "pushes.json"),
    JSON.stringify(
      records.map(({ event_id, push_id, created_at }) => ({
        event_id,
        push_id,
        created_at,
      })),
      null,
      2,
    ) + "\n",
  );
  const manifest = {
    event_id: event,
    cutoff_at: new Date(cutoffTime).toISOString(),
    exported_at: exportedAt,
    push_count: records.length,
    content_row_count: records.length * locales.length,
    coverage:
      "本機 D1 查詢結果中的活動內容紀錄；已核對來源筆數，仍須確認查詢的活動與時間範圍。內容存在不代表 FCM 接受、送達或點擊。",
  };
  await writeFile(
    join(output, "export.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  return manifest;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const { values } = parseArgs({
      options: {
        input: { type: "string" },
        event: { type: "string" },
        output: { type: "string" },
        cutoff: { type: "string" },
      },
    });
    assert(
      values.input && values.event && values.output && values.cutoff,
      "用法：npm run export:content -- --input D1查詢.json --event EVENT_ID --output 新目錄 --cutoff RFC3339時間",
    );
    console.log(JSON.stringify(await exportContent(values)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
