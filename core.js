// tiny-harness。一支 agent loop,Node 與瀏覽器共用同一份。零依賴，只用 fetch。
//
// 協議是 OpenAI 相容的 /v1/chat/completions。對閘道來說這就只是一個 HTTP POST，
// body 裡多了 tools 欄位而已；閘道不執行任何工具，它只回「我要呼叫 X」的 JSON，
// 真正跑工具的是 host 這一側。這就是同一份 core 能兩邊跑的原因：
// terminal 注入 bash/檔案工具，瀏覽器注入頁面工具，core 完全不知道差別。

/**
 * 各模型的輸出上限。量測來源：duotify-ollama-cloud-setup issue #1(2026-08-17)。
 * 邏輯與該 repo 的 bin/llmshare model_max_output 同步，兩邊不要漂掉。
 *
 * 為什麼一定要送 max_tokens:glm / kimi / minimax / gpt-oss / nemotron / deepseek
 * 都會先把 token 花在 reasoning_content。給太小 → content 回空字串、
 * finish_reason:"length"。模型沒壞，是被截斷。
 *
 * 這張表會過期（kimi-k2.5、minimax-m2.5 都下架過）。過期的症狀是撞 400，
 * 而錯誤訊息會直接講出新上限，照著改這裡即可。
 * 不要用「送超大值看它報什麼」的方式探上限。那會在閘道伺服端累積 error 紀錄。
 */
export function maxOutput(model = "") {
  if (/^(glm-|gpt-oss:|minimax-|nemotron-3-nano:)/.test(model)) return 131072;
  if (/^(mistral-large-3:|kimi-|gemma4:)/.test(model)) return 262144;
  return 65536; // deepseek 全系列、nemotron-3-ultra/super、qwen3.5；未知模型保底
}

/**
 * 跑一輪 agent loop。是 async generator。這是讓兩個 host 共用的唯一接縫：
 * terminal 端 for await 寫 stdout，前端 for await 塞 DOM，不需要 callback 或事件系統。
 *
 * @param {object}   o
 * @param {string}   o.baseUrl   例如 https://llm-share.duotify.com/v1
 * @param {string}   [o.apiKey]  瀏覽器端不要帶，讓 Worker 代打
 * @param {string}   o.model
 * @param {object[]} o.messages  會被原地 push（呼叫端可留著當對話歷史）
 * @param {object[]} [o.tools]   {name, description, parameters, run(args)->string}
 * @param {number}   [o.maxTokens] 不給就按 maxOutput() 查表
 * @param {number}   [o.maxSteps]  工具往返上限，防打轉
 * @param {AbortSignal} [o.signal]
 * @param {object}   [o.headers]  額外 header
 *
 * yield: {type:'reasoning'|'text', delta}
 *      | {type:'tool', name, args}
 *      | {type:'tool_result', name, result}
 *      | {type:'done', messages, reason}
 */
export async function* run({
  baseUrl,
  apiKey,
  model,
  messages,
  tools = [],
  maxTokens,
  maxSteps = 12,
  signal,
  headers = {},
  fetchImpl = fetch,
}) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const schema = tools.length
    ? tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }))
    : undefined;

  for (let step = 0; step < maxSteps; step++) {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...headers,
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        max_tokens: maxTokens ?? maxOutput(model),
        ...(schema ? { tools: schema } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(`tiny-harness: HTTP ${res.status} ${(await res.text()).slice(0, 500)}`);
    }

    const msg = { role: "assistant", content: "" };
    const calls = []; // 按 index 累加：有些模型會把 arguments 拆成多片送
    let reason = null;

    for await (const chunk of sse(res.body)) {
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) reason = choice.finish_reason;
      const d = choice.delta || {};
      if (d.reasoning_content) yield { type: "reasoning", delta: d.reasoning_content };
      if (d.content) {
        msg.content += d.content;
        yield { type: "text", delta: d.content };
      }
      for (const tc of d.tool_calls || []) {
        const i = tc.index ?? 0;
        const c = (calls[i] ||= { id: "", type: "function", function: { name: "", arguments: "" } });
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.function.name = tc.function.name;
        if (tc.function?.arguments) c.function.arguments += tc.function.arguments;
      }
    }

    const wanted = calls.filter(Boolean);
    if (wanted.length) msg.tool_calls = wanted;
    messages.push(msg);

    if (!wanted.length) {
      yield { type: "done", messages, reason };
      return;
    }

    for (const c of wanted) {
      const tool = byName.get(c.function.name);
      let args = {};
      let result;
      try {
        args = c.function.arguments ? JSON.parse(c.function.arguments) : {};
      } catch {
        result = `錯誤：參數不是合法 JSON:${c.function.arguments}`;
      }
      yield { type: "tool", name: c.function.name, args };
      if (result === undefined) {
        // 工具丟例外不該炸掉整個迴圈。把錯誤字串回給模型，讓它自己改。
        try {
          result = tool ? String(await tool.run(args)) : `錯誤：沒有名為 ${c.function.name} 的工具`;
        } catch (e) {
          result = `錯誤：${e.message}`;
        }
      }
      messages.push({ role: "tool", tool_call_id: c.id, content: result });
      yield { type: "tool_result", name: c.function.name, result };
    }
  }
  yield { type: "done", messages, reason: "max_steps" };
}

/**
 * 把 SSE 位元流拆成一個個 JSON 物件。
 * ponytail: 只認「一行一個 data: <json>」。 OpenAI 相容串流都長這樣（已對閘道實測）。
 * 真的遇到跨行 data 或 event: 欄位再補，不預先寫。
 */
async function* sse(body) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        yield JSON.parse(data);
      } catch {
        // 閘道偶爾插非 JSON 的 keep-alive，跳過
      }
    }
  }
}
