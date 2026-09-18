#!/usr/bin/env node
// tiny-harness 的 terminal host。core.js 不知道有 bash 或檔案這回事，
// 是這支把它們注入進去的。前端那支注入的是完全不同的一組工具。
//
//   export LLMSHARE_API_KEY=...
//   node cli.js [模型] [--yolo]
//
// --yolo：跑 bash 前不再問。預設會問，因為模型有權在你的機器上執行任何指令。
import readline from "node:readline/promises";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { run } from "./core.js";

const pexec = promisify(execFile);
const BASE = process.env.LLMSHARE_BASE_URL || "https://llm-share.duotify.com/v1";
const KEY = process.env.LLMSHARE_API_KEY;
const argv = process.argv.slice(2);
const YOLO = argv.includes("--yolo");
const MODEL = argv.find((a) => !a.startsWith("-")) || "deepseek-v4.1-flash";

if (!KEY) {
  console.error("未設 LLMSHARE_API_KEY。先 export LLMSHARE_API_KEY=你的-Virtual-Key");
  process.exit(1);
}

const c = { dim: "\x1b[2m", cyan: "\x1b[36m", yellow: "\x1b[33m", red: "\x1b[31m", off: "\x1b[0m" };
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const tools = [
  {
    name: "bash",
    description: "在使用者的機器上執行一行 shell 指令，回傳 stdout+stderr。",
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "要執行的指令" } },
      required: ["command"],
    },
    run: async ({ command }) => {
      if (!YOLO) {
        const ok = await rl.question(`${c.yellow}要執行：${command}\n允許嗎？[y/N] ${c.off}`);
        if (!/^y(es)?$/i.test(ok.trim())) return "使用者拒絕執行這個指令。";
      }
      // ponytail: 60 秒硬上限、輸出截 20KB。要跑更久的東西自己開背景。
      const { stdout, stderr } = await pexec("bash", ["-lc", command], {
        timeout: 60_000,
        maxBuffer: 20 * 1024 * 1024,
      }).catch((e) => ({ stdout: e.stdout || "", stderr: `${e.stderr || ""}\n（退出碼 ${e.code}）` }));
      return `${stdout}${stderr}`.slice(0, 20_000) || "（無輸出）";
    },
  },
  {
    name: "read_file",
    description: "讀一個檔案的內容。",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    run: ({ path }) => readFile(path, "utf8").then((s) => s.slice(0, 100_000)),
  },
  {
    name: "write_file",
    description: "把內容寫進檔案(會覆蓋)。",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
    run: async ({ path, content }) => {
      await writeFile(path, content);
      return `已寫入 ${path}（${content.length} 字元）`;
    },
  },
];

const messages = [
  {
    role: "system",
    content: `你是跑在使用者終端機裡的助理。工作目錄是 ${process.cwd()}。需要知道機器上的事就用工具查，不要猜。一律用台灣正體中文與全形標點，不得出現任何簡體字。不要用 emoji。`,
  },
];

console.log(`${c.dim}tiny-harness · ${MODEL} · ${BASE}${YOLO ? " · yolo" : ""}${c.off}`);
console.log(`${c.dim}Ctrl-C 離開${c.off}\n`);

for (;;) {
  let input;
  try {
    input = await rl.question(`${c.cyan}> ${c.off}`);
  } catch {
    break; // stdin 已關
  }
  if (!input.trim()) continue;
  messages.push({ role: "user", content: input });

  let inReasoning = false;
  try {
    for await (const e of run({ baseUrl: BASE, apiKey: KEY, model: MODEL, messages, tools })) {
      if (e.type === "reasoning") {
        if (!inReasoning) process.stdout.write(c.dim);
        inReasoning = true;
        process.stdout.write(e.delta);
      } else {
        if (inReasoning) {
          process.stdout.write(`${c.off}\n\n`);
          inReasoning = false;
        }
        if (e.type === "text") process.stdout.write(e.delta);
        if (e.type === "tool") console.log(`\n${c.dim}[${e.name}] ${JSON.stringify(e.args)}${c.off}`);
        if (e.type === "tool_result")
          console.log(`${c.dim}${e.result.split("\n").slice(0, 8).join("\n")}${c.off}\n`);
        if (e.type === "done") console.log("\n");
      }
    }
  } catch (err) {
    console.error(`\n${c.red}${err.message}${c.off}\n`);
  }
}

rl.close();
