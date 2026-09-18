# tiny-harness

一支極小的 agent loop。終端機與瀏覽器共用同一份核心，零相依，只用 `fetch`。

核心 `core.js` 不到兩百行，負責三件事：呼叫 OpenAI 相容的 `/v1/chat/completions`、解析 SSE 串流、跑工具往返迴圈。它不內建任何工具。工具由 host 注入，所以終端機那邊可以給它 bash 與檔案存取，網頁那邊給它操作 DOM 的能力，而核心完全不需要知道差別。

閘道端看到的只是一個 HTTP POST，body 裡多了 `tools` 欄位。閘道不執行工具，它只回「我要呼叫 X、參數是 Y」的 JSON，真正跑工具的是 host 這一側。這就是同一份核心能兩邊跑的原因。

## 用在終端機

```bash
export LLMSHARE_API_KEY='你的-Virtual-Key'
node cli.js                 # 預設 glm-5.2
node cli.js kimi-k2.7-code  # 指定模型
node cli.js glm-5.2 --yolo  # 跑 bash 前不再詢問
```

內建工具：`bash`、`read_file`、`write_file`。預設每次執行 bash 都會問過才跑，因為模型有權在你的機器上執行任何指令。`--yolo` 關掉這道確認。

環境變數 `LLMSHARE_BASE_URL` 可以換閘道，預設 `https://llm-share.duotify.com/v1`。任何 OpenAI 相容端點都能接。

## 不裝 Node 的版本:agent.sh

`agent.sh` 是同一套工具往返的 bash 實作，只相依 `curl` 與 `jq`，四十幾行。

```bash
export LLMSHARE_API_KEY='你的-Virtual-Key'
./agent.sh                                # 預設 glm-5.2
./agent.sh deepseek-v4.1-flash            # 指定模型
./agent.sh deepseek-v4.1-flash --yolo     # 跑 bash 前不再詢問
```

端點同樣讀 `LLMSHARE_BASE_URL`，預設就是多奇的閘道 `https://llm-share.duotify.com/v1`。模型代號用 `llmshare models` 查，要打別的 OpenAI 相容端點就改這個環境變數。

它是單一檔案，所以可以直接從 raw URL 跑起來，不需要 clone 也不需要 npm：

```bash
curl -fsSL https://raw.githubusercontent.com/yazelin/tiny-harness/main/agent.sh | bash -s -- deepseek-v4.1-flash
```

只有 `bash` 一個工具，因為 `cat` 與 heredoc 已經涵蓋讀寫檔案。`max_tokens` 查表跟 `core.js` 的 `maxOutput()` 同一份規則，改一邊要記得改另一邊。

它不做串流。`jq` 解 SSE 不划算，要看逐字吐出去用 `cli.js`。

兩個地方寫成這樣是有原因的：模型跑的指令失敗是常態，所以工具那行加了 `|| true`，否則 `set -e` 會讓一個 `cat` 讀不到檔案就殺掉整個 agent；工具往返有 12 圈上限，跟核心一樣防打轉。

## 用在網頁

```js
import { mountTerminal, TERMINAL_CSS } from "tiny-harness/web";

mountTerminal(document.getElementById("term"), {
  baseUrl: "https://你的-worker/agent",   // 金鑰留在後端代打
  model: "glm-5.2",
  tools: [{
    name: "set_background",
    description: "把頁面背景換成指定顏色。",
    parameters: { type: "object", properties: { color: { type: "string" } }, required: ["color"] },
    run: ({ color }) => { document.body.style.background = color; return `背景已換成 ${color}`; },
  }],
  system: "你在一個網頁裡。用正體中文回答。",
});
```

`baseUrl`、`model`、`apiKey` 都可以傳函式，送出當下才求值，改設定就不必重掛整個 terminal。

本機試跑：

```bash
npm run demo    # http://127.0.0.1:8191/web/demo.html
```

demo 頁的金鑰只留在分頁記憶體裡，不寫 `localStorage`，關掉分頁就沒了。

### 金鑰不能上公開頁

閘道本身沒有擋 CORS，瀏覽器直連是通的，本機 demo 就是這樣跑的。但公開網站上的任何金鑰都等於公開，所以正式站要在自己的後端放一條代打路由，把金鑰留在那裡，前端只跟自己的後端說話。

## 核心 API

```js
import { run } from "tiny-harness";

for await (const e of run({ baseUrl, apiKey, model, messages, tools })) {
  // e.type: 'reasoning' | 'text' | 'tool' | 'tool_result' | 'done'
}
```

它是 async generator，這是讓兩個 host 共用的唯一接縫。終端機端 `for await` 寫 stdout，網頁端 `for await` 塞 DOM，不需要 callback 或事件系統。

`messages` 會被原地 `push`，呼叫端留著它就是對話歷史。工具往返上限預設 12 圈，用 `maxSteps` 調整。

工具的形狀：

```js
{ name, description, parameters /* JSON Schema */, run: async (args) => string }
```

工具丟出例外不會炸掉迴圈，錯誤訊息會被當成工具結果回給模型，讓它自己修。模型叫了不存在的工具也一樣處理。

### max_tokens 按模型查表

`maxOutput(model)` 用三條前綴規則決定要送多少 `max_tokens`，量測來源是 [duotify-ollama-cloud-setup](https://github.com/yazelin/duotify-ollama-cloud-setup) issue #1，與該 repo 的 `bin/llmshare` 同步。

這一步不能省。glm、kimi、minimax、gpt-oss、nemotron、deepseek 都會先把 token 花在 `reasoning_content`，`max_tokens` 給太小的話 `content` 會回空字串、`finish_reason` 是 `length`，看起來像模型壞了，其實是被截斷。

表會過期，模型下架或改版都會。過期的症狀是撞 400，而錯誤訊息會直接講出新上限，照著改 `core.js` 就好。不要用送超大值去看它報什麼錯的方式探上限，那會在閘道伺服端累積 error 紀錄。

呼叫時傳 `maxTokens` 可以蓋掉查表結果。

## 測試

```bash
npm test
```

`test.js` 餵假的 SSE 進去，驗六件事：一輪工具往返後正確收尾、拆片的 `arguments` 能接回完整 JSON、工具丟例外不會炸掉迴圈、叫到不存在的工具會回錯誤給模型、`maxSteps` 真的擋得住打轉、HTTP 錯誤會帶出訊息。不打真的閘道，離線就能跑。

要打真的閘道請直接跑 `node cli.js`。

## 已驗證

`agent.sh` 對 `llm-share.duotify.com` 實測過 `deepseek-v4.1-flash`：工具呼叫成功那條、以及工具指令失敗（`cat` 不存在的檔案）之後迴圈沒被殺掉、錯誤回給模型繼續講話那條，兩條都通。

核心 `core.js` 對 `llm-share.duotify.com` 實測過，非串流與串流兩種模式的 tool calling 都通，串流的 `tool_calls` 會分批送達，所以核心按 `index` 累加。瀏覽器端用 Playwright 驗過完整一輪：送出訊息、模型呼叫 `set_background`、頁面背景真的變色。

## 授權

MIT，林亞澤。
