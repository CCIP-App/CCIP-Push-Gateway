import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { exportContent } from "../scripts/export-content.mjs";

const record = {
  version: 1,
  event_id: "EVENT_A",
  push_id: "00000000-0000-4000-8000-000000000001",
  created_at: "2027-03-13T10:00:00.000Z",
  expires_at: "2027-03-13T11:00:00.000Z",
  roles: ["audience", "staff"],
  title: "主辦單位",
  contents: { en: 'Lunch, "ready"\nNow', "zh-Hant": "午餐" },
};

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "opass-export-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, "source.json");
  const records = new Map();
  const save = async (name, value) => {
    if (value === undefined) records.delete(name);
    else records.set(name, value);
    await writeFile(
      input,
      JSON.stringify([
        {
          success: true,
          results: [...records.values()].map((record) => ({
            event_id: record.event_id,
            push_id: record.push_id,
            created_at: record.created_at,
            content_json: JSON.stringify(record),
            source_count: records.size,
          })),
        },
      ]),
    );
  };
  await save("first", record);
  return {
    root,
    input,
    event: "EVENT_A",
    output: join(root, "output"),
    cutoff: "2027-03-14T00:00:00Z",
    save,
  };
}

test("rejects out-of-scope rows and exports content without a dispatch result or delivery claim", async (t) => {
  const options = await fixture(t);
  await options.save("other-event", {
    ...record,
    event_id: "EVENT_B",
    title: "DO_NOT_EXPORT",
  });
  await assert.rejects(exportContent(options), /another event/);
  await options.save("other-event", undefined);
  await options.save("future", {
    ...record,
    push_id: "00000000-0000-4000-8000-000000000002",
    created_at: "2027-03-15T10:00:00.000Z",
    expires_at: "2027-03-15T11:00:00.000Z",
  });
  await assert.rejects(exportContent(options), /cutoff time/);
  await options.save("future", undefined);
  const manifest = await exportContent(options);
  assert.equal(manifest.push_count, 1);
  assert.equal(manifest.content_row_count, 2);
  const csv = await readFile(join(options.output, "content.csv"), "utf8");
  assert(csv.startsWith("\uFEFF"));
  assert(csv.includes('"Lunch, ""ready""\nNow"'));
  assert(!csv.includes("DO_NOT_EXPORT"));
  assert(!csv.includes("accepted"));
  assert.deepEqual(
    JSON.parse(await readFile(join(options.output, "pushes.json"), "utf8")),
    [
      {
        event_id: record.event_id,
        push_id: record.push_id,
        created_at: record.created_at,
      },
    ],
  );
});

test("neutralizes spreadsheet formulas in free text without corrupting the JSON identity manifest", async (t) => {
  const options = await fixture(t);
  await options.save("first", {
    ...record,
    title: '=HYPERLINK("https://example.org")',
    contents: { en: "  +1", "zh-Hant": "\t@SUM(1)" },
  });
  await options.save("fullwidth", {
    ...record,
    push_id: "00000000-0000-4000-8000-000000000002",
    contents: { en: "＝1+1", "zh-Hant": "午餐" },
  });
  await exportContent(options);
  const csv = await readFile(join(options.output, "content.csv"), "utf8");
  for (const expected of ["'=HYPERLINK", "'  +1", "'\t@SUM(1)", "'＝1+1"])
    assert(csv.includes(expected));
});

test("rejects duplicate push IDs and malformed content before creating output", async (t) => {
  const options = await fixture(t);
  await options.save("duplicate", record);
  await assert.rejects(exportContent(options), /Duplicate push_id/);
  await options.save("duplicate", undefined);
  for (const contents of [
    { en: "missing Chinese" },
    { "zh-Hant": "缺少英文" },
    { ...record.contents, fr: "unsupported locale" },
  ]) {
    await options.save("first", { ...record, contents });
    await assert.rejects(
      exportContent(options),
      /English or Traditional Chinese/,
    );
  }
  await assert.rejects(readFile(join(options.output, "content.csv")), {
    code: "ENOENT",
  });
});

test("rejects failed or incomplete D1 downloads and mismatched row identities", async (t) => {
  const options = await fixture(t);
  const valid = JSON.parse(await readFile(options.input, "utf8"));
  for (const mutate of [
    (query) => {
      query.success = false;
    },
    (query) => {
      query.results[0].source_count = 2;
    },
    (query) => {
      query.results[0].event_id = "EVENT_B";
    },
    (query) => {
      query.results[0].push_id = "wrong";
    },
    (query) => {
      query.results[0].created_at = "wrong";
    },
  ]) {
    const invalid = structuredClone(valid);
    mutate(invalid[0]);
    await writeFile(options.input, JSON.stringify(invalid));
    await assert.rejects(exportContent(options), /D1/);
    await assert.rejects(readFile(join(options.output, "content.csv")), {
      code: "ENOENT",
    });
  }
});

test("refuses an empty scope, timezone-free cutoff and existing output directory", async (t) => {
  const options = await fixture(t);
  await options.save("first", undefined);
  await assert.rejects(exportContent(options), /No content records/);
  await options.save("first", record);
  await assert.rejects(
    exportContent({ ...options, cutoff: "2027-03-14" }),
    /timezone/,
  );
  await assert.rejects(
    exportContent({ ...options, cutoff: "2027-02-30T10:00:00Z" }),
    /Invalid calendar date/,
  );
  await exportContent(options);
  await assert.rejects(exportContent(options), { code: "EEXIST" });
});

test("runs the documented CLI with only local files", async (t) => {
  const options = await fixture(t);
  const stdout = execFileSync(
    process.execPath,
    [
      "scripts/export-content.mjs",
      "--input",
      options.input,
      "--event",
      options.event,
      "--output",
      options.output,
      "--cutoff",
      options.cutoff,
    ],
    { encoding: "utf8" },
  );
  assert.equal(JSON.parse(stdout).push_count, 1);
});

test("exports native local D1 query output with event, cutoff and completeness checks", async (t) => {
  const options = await fixture(t);
  const wrangler = (...args) =>
    execFileSync(
      process.execPath,
      [
        "node_modules/wrangler/bin/wrangler.js",
        "d1",
        ...args,
        "--local",
        "--persist-to",
        join(options.root, "database"),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          WRANGLER_LOG_PATH: join(options.root, "logs"),
          WRANGLER_SEND_METRICS: "false",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  wrangler("migrations", "apply", "PUSH_RECORDS");
  const boundary = {
    ...record,
    push_id: "00000000-0000-4000-8000-000000000002",
    created_at: "2027-03-14T00:00:00.000Z",
    expires_at: "2027-03-14T01:00:00.000Z",
  };
  const records = [
    record,
    boundary,
    {
      ...record,
      push_id: "00000000-0000-4000-8000-000000000003",
      event_id: "EVENT_B",
    },
    {
      ...record,
      push_id: "00000000-0000-4000-8000-000000000004",
      created_at: "2027-03-14T00:00:00.001Z",
      expires_at: "2027-03-14T01:00:00.001Z",
    },
  ];
  const literal = (value) => `'${value.replaceAll("'", "''")}'`;
  const seed = join(options.root, "seed.sql");
  await writeFile(
    seed,
    records
      .map(
        (value) =>
          `INSERT INTO push_records (push_id, event_id, created_at, content_json) VALUES (${[value.push_id, value.event_id, value.created_at, JSON.stringify(value)].map(literal).join(",")});`,
      )
      .join("\n"),
  );
  wrangler("execute", "PUSH_RECORDS", "--file", seed);
  const query = (await readFile("reports/content.sql", "utf8")).replace(
    "'EXAMPLE_2027'",
    "'EVENT_A'",
  );
  const queryFile = join(options.root, "content.sql");
  await writeFile(queryFile, query);
  await writeFile(
    options.input,
    wrangler("execute", "PUSH_RECORDS", "--file", queryFile, "--json"),
  );
  assert.equal((await exportContent(options)).push_count, 2);
  assert.deepEqual(
    JSON.parse(await readFile(join(options.output, "pushes.json"), "utf8")).map(
      (value) => value.push_id,
    ),
    [record.push_id, boundary.push_id],
  );
  await writeFile(
    queryFile,
    query.replace(
      "ORDER BY created_at, push_id;",
      "ORDER BY created_at, push_id LIMIT 1;",
    ),
  );
  await writeFile(
    options.input,
    wrangler("execute", "PUSH_RECORDS", "--file", queryFile, "--json"),
  );
  await assert.rejects(
    exportContent({ ...options, output: join(options.root, "truncated") }),
    /source row count/,
  );
});
