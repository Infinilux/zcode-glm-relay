#!/bin/bash
# HF Space 入口:恢复账号池 → 固定网关 key → 重同步凭据(容器内重新加密) → 起网关
# 全部材料来自 Space Secrets,镜像/仓库里没有任何凭据。
set -euo pipefail
cd /app

POOL_DIR="$HOME/.zcode-pool/accounts"

# ---- 1. 从 ZCODE_ACCOUNTS_B64 恢复 ~/.zcode-pool/accounts/*.json -------------
# 内容是 {"<uuid>": <账号json对象>, ...} 的 base64(生成命令见 部署日志.md)
if [ -n "${ZCODE_ACCOUNTS_B64:-}" ]; then
  mkdir -p "$POOL_DIR"
  printf '%s' "$ZCODE_ACCOUNTS_B64" | base64 -d > /tmp/accounts-bundle.json
  node -e '
    const fs = require("fs");
    const m = JSON.parse(fs.readFileSync("/tmp/accounts-bundle.json", "utf8"));
    for (const [k, v] of Object.entries(m)) {
      fs.writeFileSync(process.env.HOME + "/.zcode-pool/accounts/" + k + ".json", JSON.stringify(v, null, 2));
    }
    console.log("[entrypoint] pool files restored:", Object.keys(m).length);
  '
  rm -f /tmp/accounts-bundle.json
else
  echo "[entrypoint] !! ZCODE_ACCOUNTS_B64 未配置,引擎将无凭据可同步"
fi

# ---- 2. 固定网关对外 key(不固定的话每次重启都会随机换,手机 key 就失效了) ----
if [ -n "${GATEWAY_KEY:-}" ]; then
  mkdir -p gateway
  printf '%s' "$GATEWAY_KEY" > gateway/.proxykey
fi

# ---- 3. 同步凭据:解池文件(2 个是 enc:v1,需要 ZCODE_CREDENTIAL_SECRET 种子) ----
# 并用 ZCODE_PROXY_CREDENTIAL_SECRET(固定种子)重新 AES 加密成引擎的 credentials.json。
# 引擎由网关 spawn 时继承这两个 env,读写口径一致。
node sync-accounts.js

# ---- 4. 平台端口适配:Render 会注入 $PORT,网关必须监听它 ----
if [ -n "${PORT:-}" ]; then
  node -e '
    const fs = require("fs");
    const f = "/app/accounts.json";
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    j.gateway.port = Number(process.env.PORT);
    fs.writeFileSync(f, JSON.stringify(j, null, 2));
    console.log("[entrypoint] gateway.port ->", process.env.PORT);
  '
fi

# ---- 5. 起网关(0.0.0.0,强制鉴权,不开 :8899) --------------------------------
export GW_HOST="${GW_HOST:-0.0.0.0}"
export GW_REQUIRE_KEY="${GW_REQUIRE_KEY:-1}"
export GW_NO_ALIAS="${GW_NO_ALIAS:-1}"
exec node zcode-gateway.js
