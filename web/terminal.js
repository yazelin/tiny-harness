// 瀏覽器 host。跟 cli.js 是對稱的：同一份 core.js，注入的工具完全不同。
// 這裡不碰 apiKey。瀏覽器端的金鑰一律留在後端代打的 Worker 裡。
import { run } from "../core.js";

/**
 * 把一個 terminal 掛到 el 上。
 * @param {HTMLElement} el
 * @param {object} o
 * @param {string|function} o.baseUrl  代打端點（路徑要能接上 /chat/completions）
 * @param {string|function} o.model
 * @param {object[]} [o.tools]   由呼叫端注入，core 不預設任何工具
 * @param {string} [o.system]
 * @param {string} [o.greeting]
 * @param {string|function} [o.apiKey]   只給本機 demo 用；正式站不要傳
 *
 * baseUrl / model / apiKey 都可以給函式。送出當下才求值。
 * 設定變動時就不必重掛整個 terminal（重掛會把對話一起清掉）。
 * @returns {{ send(text): Promise<void>, messages: object[] }}
 */
export function mountTerminal(el, { baseUrl, model, tools = [], system, greeting, apiKey } = {}) {
  el.innerHTML = "";
  el.classList.add("th-term");
  const log = document.createElement("div");
  log.className = "th-log";
  const form = document.createElement("form");
  form.className = "th-form";
  const input = document.createElement("input");
  input.className = "th-input";
  input.autocomplete = "off";
  input.placeholder = "說點什麼…";
  const btn = document.createElement("button");
  btn.className = "th-send";
  btn.type = "submit";
  btn.textContent = "送出";
  // 這顆不只是為了手機：沒有 submit button 時 Chromium 不會做 implicit submission，
  // 按 Enter 是沒反應的（實測過）。
  form.append(input, btn);
  el.append(log, form);

  const messages = system ? [{ role: "system", content: system }] : [];
  if (greeting) line("out", greeting);

  function line(kind, text = "") {
    const d = document.createElement("div");
    d.className = `th-line th-${kind}`;
    d.textContent = text;
    log.append(d);
    log.scrollTop = log.scrollHeight;
    return d;
  }

  let busy = false;
  async function send(text) {
    if (busy || !text.trim()) return;
    busy = true;
    input.disabled = true;
    btn.disabled = true;
    line("in", `> ${text}`);
    messages.push({ role: "user", content: text });

    let out = null;
    let think = null;
    try {
      for await (const e of run({
        baseUrl: val(baseUrl),
        apiKey: val(apiKey),
        model: val(model),
        messages,
        tools,
      })) {
        if (e.type === "reasoning") {
          think ||= line("think");
          think.textContent += e.delta;
        } else if (e.type === "text") {
          out ||= line("out");
          out.textContent += e.delta;
        } else if (e.type === "tool") {
          line("tool", `[${e.name}] ${JSON.stringify(e.args)}`);
          out = think = null; // 下一輪的文字與思考各自另起一行，不然會接到上一輪去
        } else if (e.type === "tool_result") {
          line("tool", e.result.slice(0, 400));
        }
        log.scrollTop = log.scrollHeight;
      }
    } catch (err) {
      line("err", err.message);
    } finally {
      busy = false;
      input.disabled = false;
      btn.disabled = false;
      input.focus();
    }
  }

  const submit = (ev) => {
    ev.preventDefault();
    const v = input.value;
    input.value = "";
    send(v);
  };
  form.addEventListener("submit", submit);
  // 沒有 submit 按鈕的 form,Enter 不保證會觸發 submit（Chromium 實測不會），
  // 所以自己接一次。form 留著是為了手機鍵盤會顯示「送出」。
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.isComposing) submit(ev);
  });

  return { send, messages, el };
}

const val = (x) => (typeof x === "function" ? x() : x);

/** 最低限度的樣式，呼叫端要自己配色就別用它。 */
export const TERMINAL_CSS = `
.th-term{display:flex;flex-direction:column;height:100%;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}
.th-log{flex:1;overflow:auto;padding:10px;white-space:pre-wrap;word-break:break-word}
.th-line{margin:0 0 .35em}
.th-in{opacity:.85}
.th-think{opacity:.45;font-style:italic}
.th-tool{opacity:.6}
.th-err{color:#ff8080}
.th-form{display:flex;border-top:1px solid rgba(255,255,255,.12)}
.th-input{flex:1;padding:9px 10px;border:0;background:transparent;color:inherit;font:inherit;outline:none}
.th-input:disabled{opacity:.5}
.th-send{padding:0 14px;border:0;border-left:1px solid rgba(255,255,255,.12);background:transparent;
  color:inherit;font:inherit;cursor:pointer}
.th-send:hover{background:rgba(255,255,255,.06)}
.th-send:disabled{opacity:.4;cursor:default}
`;
