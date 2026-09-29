#!/bin/bash
# Render 入口:恢复号池 → 固定网关 key → 同步凭据 → 端口适配 → 起网关
# 刻意不用 set -e:任何准备步骤失败都只记日志、不拦网关起跑(起了网关 /health
# 才有输出,引擎 down 会显形在 health 里;崩了反而什么都看不到)。
set -u
cd /app

# ---- 0. 端口:Render 对 web service 注入 PORT(默认 10000);本地跑默认 3203 ----
if [ -z "${PORT:-}" ]; then
  echo "[entrypoint] PORT 未注入,兜底为 10000(Render 默认探测口)"
  export PORT=10000
fi

# ---- 1. 从 ZCODE_ACCOUNTS_B64 恢复号池文件(明文字段,无需解密种子) ------------
POOL_DIR="$HOME/.zcode-pool/accounts"
if [ -n "${ZCODE_ACCOUNTS_B64:-}" ]; then
  mkdir -p "$POOL_DIR"
  if printf '%s' "$ZCODE_ACCOUNTS_B64" | base64 -d > /tmp/accounts-bundle.json 2>/dev/null; then
    node -e '
      const fs = require("fs");
      const m = JSON.parse(fs.readFileSync("/tmp/accounts-bundle.json", "utf8"));
      for (const [k, v] of Object.entries(m)) {
        fs.writeFileSync(process.env.HOME + "/.zcode-pool/accounts/" + k + ".json", JSON.stringify(v, null, 2));
      }
      console.log("[entrypoint] pool files restored:", Object.keys(m).join(","));
    ' || echo "[entrypoint] WARN 号池文件写入失败(见上)"
  else
    echo "[entrypoint] WARN ZCODE_ACCOUNTS_B64 不是合法 base64,跳过号池恢复"
  fi
  rm -f /tmp/accounts-bundle.json
else
  echo "[entrypoint] WARN ZCODE_ACCOUNTS_B64 未配置,引擎将无凭据"
fi

# ---- 2. 固定网关对外 key(不固定则每次重启随机换,手机 key 失效) ----------------
if [ -n "${GATEWAY_KEY:-}" ]; then
  mkdir -p gateway
  printf '%s' "$GATEWAY_KEY" > gateway/.proxykey
fi

# ---- 3. 同步凭据:写每号 credentials.json(用 ZCODE_PROXY_CREDENTIAL_SECRET 加密)+ config.yaml ----
if ! node sync-accounts.js; then
  echo "[entrypoint] WARN sync-accounts 失败,引擎将拿不到凭据(网关照常起,/health 可见)"
fi

# ---- 4. 端口适配写回 accounts.json,再起网关 ----------------------------------
node -e '
  const fs = require("fs");
  const f = "/app/accounts.json";
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  j.gateway.port = Number(process.env.PORT);
  fs.writeFileSync(f, JSON.stringify(j, null, 2));
  console.log("[entrypoint] gateway.port ->", process.env.PORT);
' || echo "[entrypoint] WARN accounts.json 端口改写失败"

export GW_HOST="${GW_HOST:-0.0.0.0}"
export GW_REQUIRE_KEY="${GW_REQUIRE_KEY:-1}"
export GW_NO_ALIAS="${GW_NO_ALIAS:-1}"
exec node zcode-gateway.js
