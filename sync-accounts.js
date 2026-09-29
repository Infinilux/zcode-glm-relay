#!/usr/bin/env node
'use strict';
/**
 * sync-accounts.js — 把 zcode-pool 的账号同步成本地 zcode-proxy 实例的凭据 + 配置。
 *
 * 为什么这么写：
 *   zcode-proxy（TriDefender/zcode-api）是**单凭据**设计（AuthManager 只持有一份
 *   Credential），所以「多号」= 每个号起一个实例，各自一个 store 目录 + 端口。
 *   凭据文件是 AES-256-GCM 加密的，密钥派生自机器指纹：
 *       key = SHA-256(`${os.homedir()}-${os.platform()}-${os.arch()}`)
 *       文件格式 = {"encrypted": base64(iv[12] || ciphertext || tag[16])}
 *   这套派生只在本机有效，换机器/重装系统要重新同步（与上游 store.ts 一致）。
 *
 * 数据来源：~/.zcode-pool/accounts/<accountId>.json
 *   - credentials.zcodejwttoken  → start-plan 的 Authorization: Bearer <jwt>
 *   - virtual_device_mid         → identity.deviceMid（客户端设备指纹，必须稳定）
 *
 * 用法：node zcode/sync-accounts.js [--dry]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const BASE = __dirname;
const REG = JSON.parse(fs.readFileSync(path.join(BASE, 'accounts.json'), 'utf8'));
const DRY = process.argv.includes('--dry');

// ── 与 zcode-proxy src/auth/store.ts 完全一致的密钥派生 ──────────────────────
function storeKey() {
  const seed = process.env.ZCODE_PROXY_CREDENTIAL_SECRET
    || `${os.homedir()}-${os.platform()}-${os.arch()}`;
  return crypto.createHash('sha256').update(seed, 'utf8').digest();
}

function encryptCredential(cred) {
  const key = storeKey();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(cred), 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return JSON.stringify({ encrypted: Buffer.concat([iv, ct, tag]).toString('base64') });
}

/** 稳定的代理密钥：每个实例一个，首次生成后写盘复用（new-api 渠道 key 就是它）。 */
function proxyKeyFor(dir) {
  const f = path.join(dir, '.proxykey');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  const k = 'zcode' + crypto.randomBytes(12).toString('hex');
  if (!DRY) fs.writeFileSync(f, k, 'utf8');
  return k;
}

// ── zcode-pool 的加密凭据（2026-09-28 起该池会把值写成 enc:v1:）────────────
// 格式：enc:v1: + base64url(nonce12) + "." + base64url(tag16) + "." + base64url(ct)
// 密钥派生（已用 watt 号实测解出 JWT）：SHA-256(`zcode-credential-fallback:{platform}:{home}:{user}`)
// 与 zcode-proxy 的 store 派生（homedir-platform-arch）是两套，别混。
function poolCredKey() {
  const seed = process.env.ZCODE_CREDENTIAL_SECRET
    || `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${process.env.USERNAME || process.env.USER || ''}`;
  return crypto.createHash('sha256').update(seed, 'utf8').digest();
}

function decryptPoolValue(v) {
  if (typeof v !== 'string' || !v.startsWith('enc:v1:')) return v;
  const parts = v.slice(7).split('.');
  if (parts.length !== 3) throw new Error('enc:v1 格式异常（期望 3 段）');
  const [n, t, c] = parts;
  const d = crypto.createDecipheriv('aes-256-gcm', poolCredKey(), Buffer.from(n, 'base64url'));
  d.setAuthTag(Buffer.from(t, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(c, 'base64url')), d.final()]).toString('utf8');
}

function resolvePoolDir() {
  return REG.pool_dir.replace('%USERPROFILE%', os.homedir());
}

function readPoolAccount(accountId) {
  const f = path.join(resolvePoolDir(), accountId + '.json');
  if (!fs.existsSync(f)) throw new Error(`账号文件不存在: ${f}`);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

function yamlFor(inst, key, deviceMid) {
  const models = (REG.models || ['glm-5.3', 'glm-5.3-flash']).map((m) => `  - ${m}`).join('\n');
  return `# 由 zcode/sync-accounts.js 生成，不要手改（改 accounts.json 再跑一次）
server:
  port: ${inst.port}
  host: "127.0.0.1"

auth:
  # new-api 渠道用这个 key 访问本地代理
  proxyApiKey: "${key}"

provider: zai
# start-plan（免费体验套餐）走 zcode.z.ai + JWT，并自动过阿里无痕验证码
plan: start-plan

defaultModel: glm-5.3

models:
${models}

identity:
  appVersion: "${REG.app_version || '3.14.3'}"
  sourceTitle: "electron"
  refererOrigin: "https://zcode.z.ai"
  deviceMid: "${deviceMid}"

clientIdentity:
  mode: observe
  ttlSeconds: 900
  maxSessions: 1024

responses:
  enabled: true
  store:
    maxEntries: 1000
    ttlMs: 86400000

# 领取活动套餐交给 zcode-pool 自己（它 auto_claim 开着），这里关掉避免重复抢
claim:
  enabled: false
  auto: false

endpointRouting:
  enabled: true
  origin: "https://zcode.z.ai"

# start-plan 不走签名，只走 captcha；这里保持默认（签名对 start-plan 永久豁免）
clientSigning:
  enabled: true
  origin: "https://zcode.z.ai"

logging:
  level: info
`;
}

let changed = 0;
const summary = [];
for (const inst of REG.instances) {
  if (!inst.enabled) { summary.push(`skip  ${inst.name}（enabled=false）`); continue; }
  const dir = path.join(BASE, inst.dir);
  if (!DRY) fs.mkdirSync(dir, { recursive: true });

  const acc = readPoolAccount(inst.accountId);
  const jwt = decryptPoolValue(acc.credentials && acc.credentials['zcodejwttoken']);
  if (!jwt) throw new Error(`${inst.name}: 账号里没有 credentials.zcodejwttoken`);
  let info = {};
  try { info = JSON.parse(decryptPoolValue(acc.credentials['oauth:zai:user_info']) || '{}'); } catch { /* 忽略 */ }
  const deviceMid = acc.virtual_device_mid || crypto.randomUUID();
  const userId = info.id || acc.virtual_arms_uid || '';

  // start-plan 只用 jwt；provider 固定 zai
  const cred = { provider: 'zai', jwt, userId };
  const key = proxyKeyFor(dir);

  if (!DRY) {
    fs.writeFileSync(path.join(dir, 'credentials.json'), encryptCredential(cred), 'utf8');
    fs.writeFileSync(path.join(dir, 'config.yaml'), yamlFor(inst, key, deviceMid), 'utf8');
  }
  changed++;
  summary.push(`sync  ${inst.name.padEnd(18)} :${inst.port}  ${info.displayName || acc.name}  <${info.email || '-'}>  jwt=${jwt.length}字符`);
}

console.log(summary.join('\n'));
console.log(`\n${DRY ? '[dry-run] 未写入' : '完成'}，共 ${changed} 个实例。`);
console.log('提示：跑 node zcode/start-zcode.js 拉起全部实例。');
