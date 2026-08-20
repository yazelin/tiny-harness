// node test.js。不用測試框架。餵假的 SSE，驗迴圈真的跑完一輪工具就停。
// 這裡不打真的閘道（要打真的用 `node cli.js`）。
import assert from "node:assert/strict";
import { run, maxOutput } from "./core.js";

const sse = (lines) =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const l of lines) c.enqueue(new TextEncoder().encode(`data: ${l}\n\n`));
        c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        c.close();
      },
    }),
    { status: 200 },
  );

const chunk = (delta, finish_reason = null) =>
  JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] });

// --- 1. 一輪工具往返後收尾 -------------------------------------------------
{
  const sent = [];
  let turn = 0;
  const fetchImpl = async (url, init) => {
    sent.push(JSON.parse(init.body));
    turn++;
    if (turn === 1) {
      // 故意把 arguments 拆成兩片，驗按 index 累加是對的
      return sse([
        chunk({ role: "assistant", reasoning_content: "想一下" }),
        chunk({ tool_calls: [{ index: 0, id: "call_1", function: { name: "add", arguments: '{"a":2,' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '"b":3}' } }] }),
        chunk({}, "tool_calls"),
      ]);
    }
    return sse([chunk({ content: "答案是 5" }), chunk({}, "stop")]);
  };

  const messages = [{ role: "user", content: "2+3" }];
  const tools = [
    {
      name: "add",
      description: "相加",
      parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
      run: async ({ a, b }) => String(a + b),
    },
  ];

  const events = [];
  for await (const e of run({ baseUrl: "http://x/v1", model: "glm-5.2", messages, tools, fetchImpl }))
    events.push(e);

  assert.equal(sent.length, 2, "應該打兩次：一次拿 tool_call,一次拿最終答案");
  assert.equal(sent[0].max_tokens, 131072, "max_tokens 要按模型查表");
  assert.equal(sent[0].tools[0].function.name, "add");
  assert.deepEqual(
    events.find((e) => e.type === "tool").args,
    { a: 2, b: 3 },
    "拆片的 arguments 要被接回完整 JSON",
  );
  assert.equal(events.find((e) => e.type === "tool_result").result, "5");
  assert.equal(events.at(-1).type, "done");
  assert.equal(events.at(-1).reason, "stop");
  assert.equal(messages.at(-1).content, "答案是 5");
  assert.equal(messages[2].role, "tool", "工具結果要以 role:tool 回填");
  assert.equal(messages[2].tool_call_id, "call_1");
}

// --- 2. 工具丟例外 → 錯誤字串回給模型，不炸掉迴圈 --------------------------
{
  let turn = 0;
  const fetchImpl = async () =>
    ++turn === 1
      ? sse([
          chunk({ tool_calls: [{ index: 0, id: "c", function: { name: "boom", arguments: "{}" } }] }),
          chunk({}, "tool_calls"),
        ])
      : sse([chunk({ content: "抱歉" }), chunk({}, "stop")]);

  const messages = [{ role: "user", content: "炸" }];
  const tools = [{ name: "boom", description: "", parameters: {}, run: async () => { throw new Error("壞了"); } }];
  const events = [];
  for await (const e of run({ baseUrl: "http://x/v1", model: "m", messages, tools, fetchImpl }))
    events.push(e);
  assert.match(events.find((e) => e.type === "tool_result").result, /壞了/);
  assert.equal(events.at(-1).type, "done");
}

// --- 3. 模型叫了不存在的工具 ------------------------------------------------
{
  let turn = 0;
  const fetchImpl = async () =>
    ++turn === 1
      ? sse([
          chunk({ tool_calls: [{ index: 0, id: "c", function: { name: "nope", arguments: "{}" } }] }),
          chunk({}, "tool_calls"),
        ])
      : sse([chunk({ content: "好" }), chunk({}, "stop")]);
  const messages = [{ role: "user", content: "x" }];
  const events = [];
  for await (const e of run({ baseUrl: "http://x/v1", model: "m", messages, tools: [], fetchImpl }))
    events.push(e);
  assert.match(events.find((e) => e.type === "tool_result").result, /沒有名為 nope/);
}

// --- 4. maxSteps 擋住打轉 ---------------------------------------------------
{
  const fetchImpl = async () =>
    sse([
      chunk({ tool_calls: [{ index: 0, id: "c", function: { name: "loop", arguments: "{}" } }] }),
      chunk({}, "tool_calls"),
    ]);
  const messages = [{ role: "user", content: "x" }];
  const tools = [{ name: "loop", description: "", parameters: {}, run: async () => "again" }];
  let calls = 0;
  for await (const e of run({ baseUrl: "http://x/v1", model: "m", messages, tools, maxSteps: 3, fetchImpl }))
    if (e.type === "tool") calls++;
  assert.equal(calls, 3, "maxSteps 要真的擋住");
}

// --- 5. HTTP 錯誤要帶出訊息 -------------------------------------------------
{
  const fetchImpl = async () => new Response("no healthy deployments", { status: 400 });
  await assert.rejects(
    (async () => {
      for await (const _ of run({ baseUrl: "http://x/v1", model: "m", messages: [], fetchImpl }));
    })(),
    /HTTP 400.*no healthy deployments/s,
  );
}

// --- 6. 查表 ---------------------------------------------------------------
assert.equal(maxOutput("glm-5.2"), 131072);
assert.equal(maxOutput("kimi-k2.7-code"), 262144);
assert.equal(maxOutput("deepseek-v4-pro:cloud"), 65536);
assert.equal(maxOutput("沒看過的模型"), 65536);

console.log("全部通過");
