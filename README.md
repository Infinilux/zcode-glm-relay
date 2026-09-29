# zcode-glm-relay

ZCode/GLM 反代的云端版:zcode 网关 + 2 个 `zcode-proxy` 引擎(官方 linux-x64 v4.7.1),
对外暴露 `glm-5.3` / `glm-5.3-flash`(OpenAI 兼容,Bearer 网关 key)。
跑在 Render 免费档(512MB / 休眠靠 GitHub Actions 每 10 分钟 ping)。

**平台自适应**:监听端口取环境变量 `PORT`(Render 注入),未注入则用 accounts.json 里的 3203。

## 必配环境变量(Render → Environment)

| Key | 值 |
|---|---|
| `ZCODE_ACCOUNTS_B64` | 号池 JSON 打包 base64(生成命令见本机 `部署日志.md`,不落仓库) |
| `GATEWAY_KEY` | 对外 API key(手机客户端用) |
| `ZCODE_PROXY_CREDENTIAL_SECRET` | 引擎凭据加密种子(强随机) |
| `ZCODE_CREDENTIAL_SECRET` | 号池 enc:v1 解密种子(与本机一致) |

## 结构

- `entrypoint.sh` — 恢复号池 → 固定网关 key → 同步凭据 → 适配 $PORT → 起网关
- `zcode-gateway.js` — 网关(轮询选号/故障转移/引擎保活/SSE 透传),相对线上版的 3 处 [HF] 差异见文件头注释
- `sync-accounts.js` / `blackbox.js` — 原样拷贝自线上 `zcode/`(退役留档目录)
- `.github/workflows/keepalive.yml` — 防 Render 休眠

⚠️ 风险自负:start-plan 上游有风控(数据中心 IP + 多号属加压项),用户知情选择。
