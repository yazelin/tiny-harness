#!/usr/bin/env bash
# tiny-harness 的 bash 版:同一套工具往返,只靠 curl 與 jq。
# 用法: LLMSHARE_API_KEY=xxx ./agent.sh [model] [--yolo]
set -euo pipefail
command -v jq >/dev/null || { echo "需要 jq"; exit 1; }
: "${LLMSHARE_API_KEY:?請先 export LLMSHARE_API_KEY}"

BASE="${LLMSHARE_BASE_URL:-https://llm-share.duotify.com/v1}"
# 參數不看位置:第一個不以 - 開頭的是模型,--yolo 放哪都算
MODEL=""; YOLO=""
for a in "$@"; do
  case "$a" in
    --yolo) YOLO=1 ;;
    -*)     echo "不認得的選項:$a"; exit 1 ;;
    *)      [ -n "$MODEL" ] || MODEL="$a" ;;
  esac
done
MODEL="${MODEL:-deepseek-v4.1-flash}"
MAX_STEPS=12
SHOW="${AGENT_SHOW_LINES:-12}"   # 畫面只印前幾行；送給模型的永遠是完整內容

# 與 core.js 的 maxOutput() 同一張表。給太小會讓 reasoning 吃光額度、content 回空字串。
case "$MODEL" in
  glm-*|gpt-oss:*|minimax-*|nemotron-3-nano:*) MAX_TOKENS=131072 ;;
  mistral-large-3:*|kimi-*|gemma4:*)           MAX_TOKENS=262144 ;;
  *)                                            MAX_TOKENS=65536 ;;
esac

TOOLS='[{"type":"function","function":{
  "name":"bash","description":"在使用者機器上執行 bash 指令,回傳 stdout 與 stderr。",
  "parameters":{"type":"object","properties":{"cmd":{"type":"string"}},"required":["cmd"]}}}]'

H=$(mktemp); trap 'rm -f "$H" "$H.t"' EXIT
jq -n '[{role:"system",content:"你是終端機裡的助手。需要看檔案或跑指令時用 bash 工具，不要猜。一律用台灣正體中文，標點一律全形（，。：；？！），不得出現任何簡體字。不要用 emoji。"}]' > "$H"
push() { jq "$@" "$H" > "$H.t" && mv "$H.t" "$H"; }
say()  { printf '\033[36m%s\033[0m\n' "$1"; }

printf '\033[2m%s · %s\033[0m\n' "$MODEL" "$BASE"
while :; do
  printf '\n\033[32m> \033[0m'; IFS= read -r user || { echo; break; }
  [ -z "$user" ] && continue
  push --arg c "$user" '. + [{role:"user",content:$c}]'

  for ((step = 0; step < MAX_STEPS; step++)); do
    resp=$(jq -n --arg m "$MODEL" --argjson n "$MAX_TOKENS" \
                 --argjson msgs "$(cat "$H")" --argjson tools "$TOOLS" \
                 '{model:$m,messages:$msgs,tools:$tools,max_tokens:$n}' |
           curl -sS "$BASE/chat/completions" \
                -H "Authorization: Bearer $LLMSHARE_API_KEY" \
                -H 'Content-Type: application/json' --data-binary @-)
    msg=$(jq -e -c '.choices[0].message' <<<"$resp" 2>/dev/null) || {
      say "閘道回了非預期的東西:"; head -c 500 <<<"$resp"; echo; break; }
    push --argjson m "$msg" '. + [$m]'

    calls=$(jq -c '.tool_calls // [] | .[]' <<<"$msg")
    if [ -z "$calls" ]; then jq -r '.content // ""' <<<"$msg" | sed 's/^/  /'; break; fi

    while IFS= read -r call; do
      id=$(jq -r '.id' <<<"$call")
      # arguments 是一個 JSON 字串,要 fromjson 再取欄位
      cmd=$(jq -r '.function.arguments | fromjson.cmd // ""' <<<"$call")
      say "  \$ $cmd"
      out=""
      if [ -z "$YOLO" ]; then
        printf '  跑嗎? [y/N] '; read -r ok < /dev/tty || ok=n
        [ "$ok" = y ] || out="使用者拒絕執行這個指令。"
      fi
      # 工具失敗不中斷迴圈,錯誤訊息當結果回給模型,讓它自己修
      # set -e + pipefail:指令失敗是常態,不能讓它殺掉 agent
      [ -n "$out" ] || out=$(bash -c "$cmd" 2>&1 | head -c 8000 || true)
      # 畫面截斷與送給模型的內容是兩件事，這裡只截畫面
      n=$(grep -c '' <<<"$out")
      head -n "$SHOW" <<<"$out" | sed 's/^/  | /'
      if [ "$n" -gt "$SHOW" ]; then
        printf '  \033[2m| … 還有 %d 行，已完整送給模型\033[0m\n' "$((n - SHOW))"
      fi
      push --arg id "$id" --arg c "$out" '. + [{role:"tool",tool_call_id:$id,content:$c}]'
    done <<<"$calls"
  done
  if [ "$step" -eq "$MAX_STEPS" ]; then say "工具往返超過 $MAX_STEPS 圈,停下來。"; fi
done
