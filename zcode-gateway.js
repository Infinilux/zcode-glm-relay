#!/usr/bin/env node
'use strict';
/**
 * zcode-gateway.js [HF Space 版]
 *
 * 相对线上 zcode-gateway.js(2026-09-28 版,Documents/Qoder/2026-09-19/4a454652/zcode/)
 * 只有 3 处差异,每处都标了 [HF];其余(轮询选号/故障转移/引擎保活/watchPool/SSE 透传)
 * 与原版逐行一致:
 *   [HF] 1. 监听地址走 GW_HOST 环境变量,容器里设 0.0.0.0(HF 平台代理才够得着);
 *        原版写死 127.0.0.1(它是纯本地服务)。
 *   [HF] 2. 对外鉴权默认强制(除 /health 和 / 外都要 Bearer <gateway/.proxykey>)。
 *        原版 09-28 因为 ZCode 客户端带不了网关 key 而放宽;容器里没有 ZCode 客户端,
 *        而这个端口要暴露公网,必须恢复强校验。要临时放开设 GW_REQUIRE_KEY=0。
 *   [HF] 3. :8899 客户端别名口默认不开(GW_NO_ALIAS=1):那是给 D:\ZCode 桌面客户端的,
 *        容器里没有这个东西,少开一个监听少一个暴露面。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const os = require('os');
const { spawn, execFileSync } = require('child_process');

const BASE = __dirname;
const LOG_DIR = path.join(BASE, 'logs');
const bb = require('./blackbox').install({ file: path.join(LOG_DIR, 'zcode-crash.log'), tag: 'gateway' });
const REG = JSON.parse(fs.readFileSync(path.join(BASE, 'accounts.json'), 'utf8'));
const GW = REG.gateway || { port: 3203, name: 'zcode', dir: 'gateway' };
const BIN = path.join(BASE, REG.proxy_bin);
const GW_DIR = path.join(BASE, GW.dir);
const HOST = process.env.GW_HOST || '127.0.0.1'; // [HF 1]
const REQUIRE_KEY = (process.env.GW_REQUIRE_KEY || '1') === '1'; // [HF 2]
const NO_ALIAS = (process.env.GW_NO_ALIAS || '0') === '1'; // [HF 3]

// 对外密钥(手机客户端的 API key 就是它;entrypoint 会用 Secrets 固定它)
const GW_KEY_FILE = path.join(GW_DIR, '.proxykey');
fs.mkdirSync(GW_DIR, { recursive: true });
if (!fs.existsSync(GW_KEY_FILE)) {
  fs.writeFileSync(GW_KEY_FILE, 'zcodegw' + require('crypto').randomBytes(12).toString('hex'), 'utf8');
}
const GW_KEY = fs.readFileSync(GW_KEY_FILE, 'utf8').trim();

// 引擎清单
const ENGINES = REG.instances.filter((i) => i.enabled).map((i) => ({
  name: i.name,
  port: i.port,
  dir: path.join(BASE, i.dir),
  key: fs.existsSync(path.join(BASE, i.dir, '.proxykey'))
    ? fs.readFileSync(path.join(BASE, i.dir, '.proxykey'), 'utf8').trim()
    : '',
  child: null,
  healthy: false,
  fails: 0,
}));

// ── 引擎保活 ────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portUp(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(1000, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

function startEngine(e) {
  if (e.child && e.child.exitCode === null) return;
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const fd = fs.openSync(path.join(LOG_DIR, `engine-${e.name}.log`), 'a');
  e.child = spawn(BIN, ['--cli', 'serve'], {
    cwd: e.dir,
    env: { ...process.env, ZCODE_PROXY_STORE_DIR: e.dir },
    stdio: ['ignore', fd, fd],
  });
  e.child.on('exit', () => { e.child = null; e.healthy = false; });
  log(`引擎 ${e.name} 已拉起 :${e.port}`);
}

async function watchEngines() {
  for (;;) {
    for (const e of ENGINES) {
      const up = await portUp(e.port);
      e.healthy = up;
      if (!up) {
        if (e.fails++ % 3 === 0) { try { startEngine(e); } catch (err) { log(`引擎 ${e.name} 拉起失败 ${err.message}`); } }
      } else {
        e.fails = 0;
      }
    }
    await sleep(5000);
  }
}

// ---- zcode-pool credential watch(2026-09-28) ------------------------------
// 容器里 pool 文件来自 Secrets、启动后不再变,这个巡检天然空转;保留原逻辑不动,
// 真有变化(比如以后改成挂盘)它照样工作。
const POOL_DIR = REG.pool_dir.replace('%USERPROFILE%', os.homedir());

function poolSnapshot() {
  const out = {};
  try {
    for (const f of fs.readdirSync(POOL_DIR)) {
      if (!f.toLowerCase().endsWith('.json') || f.startsWith('.')) continue;
      const st = fs.statSync(path.join(POOL_DIR, f));
      out[f] = `${st.mtimeMs}:${st.size}`;
    }
  } catch { /* pool dir unreadable for now */ }
  return out;
}

async function watchPool() {
  let last = poolSnapshot();
  log(`credential watch started on ${POOL_DIR} (${Object.keys(last).length} files)`);
  for (;;) {
    await sleep(60000);
    const now = poolSnapshot();
    const changed = Object.keys(now).filter((k) => last[k] !== now[k]);
    const removed = Object.keys(last).filter((k) => !(k in now));
    last = now;
    if (changed.length === 0 && removed.length === 0) continue;
    log(`pool changed (mod:${changed.join(',') || '-'} del:${removed.join(',') || '-'}) -> resync`);
    try {
      const out = execFileSync(process.execPath, [path.join(BASE, 'sync-accounts.js')], { encoding: 'utf8' });
      log('resync ok: ' + out.trim().split('\n').filter((l) => l.startsWith('sync')).join(' | '));
    } catch (err) {
      log(`resync failed, keeping old creds: ${String(err.message).slice(0, 160)}`);
      continue;
    }
    for (const e of ENGINES) {
      if (e.child) { try { e.child.kill(); } catch { /* already gone */ } }
      e.healthy = false;
      e.fails = -1;
    }
    log('engines stopped; supervisor will restart them with fresh creds');
  }
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
}

// ── 转发 ────────────────────────────────────────────────────────────────────
const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer']);

function pickOrder() {
  const up = ENGINES.filter((e) => e.healthy);
  const pool = up.length ? up : ENGINES;
  if (pool.length === 0) return [];
  const start = cursor++ % pool.length;
  return pool.slice(start).concat(pool.slice(0, start));
}
let cursor = 0;

/** 把请求打到某个引擎;拿到响应头就 resolve(正文流式回传,不缓冲)。 */
function forward(e, req, body) {
  return new Promise((resolve, reject) => {
    const headers = { ...req.headers };
    for (const k of Object.keys(headers)) if (HOP.has(k.toLowerCase())) delete headers[k];
    headers.authorization = 'Bearer ' + e.key;
    headers.host = `127.0.0.1:${e.port}`;

    const pr = http.request(
      { host: '127.0.0.1', port: e.port, path: req.url, method: req.method, headers },
      (res) => resolve(res),
    );
    pr.on('error', reject);
    pr.setTimeout(0);
    if (body && body.length) pr.write(body);
    pr.end();
  });
}

const handler = async (req, res) => {
  try {
    if (req.url === '/health' || req.url === '/') {
      const st = ENGINES.map((e) => `${e.name}:${e.healthy ? 'up' : 'down'}`).join(' ');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, service: GW.name, engines: st }));
    }

    // [HF 2] 公网暴露,强制网关 key(健康检查除外)。转发时仍会用引擎 key 覆盖
    // authorization,上游凭据不暴露。
    if (REQUIRE_KEY) {
      const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
      if (tok !== GW_KEY) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'invalid gateway key', type: '401' } }));
      }
    }

    // 读请求体(可能要重试,必须能重放)
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);

    const order = pickOrder();
    if (order.length === 0) {
      res.writeHead(503, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'no zcode engine available', type: '503' } }));
    }

    let lastErr = '';
    for (const e of order) {
      try {
        const pr = await forward(e, req, body);
        if (pr.statusCode >= 500) {
          pr.resume();
          lastErr = `engine ${e.name} HTTP ${pr.statusCode}`;
          e.healthy = false;
          log(`跳过 ${e.name}：${lastErr}`);
          continue;
        }
        const out = {};
        for (const [k, v] of Object.entries(pr.headers)) if (!HOP.has(k.toLowerCase())) out[k] = v;
        res.writeHead(pr.statusCode, out);
        pr.pipe(res);
        return;
      } catch (err) {
        lastErr = `engine ${e.name} ${err.message}`;
        e.healthy = false;
        log(`跳过 ${e.name}：${err.message}`);
      }
    }

    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'all zcode engines failed: ' + lastErr, type: '502' } }));
  } catch (err) {
    try { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: err.message } })); } catch { /* 已断开 */ }
  }
};

// 同一个 server 对象不能监听两个端口,别名口必须是独立 createServer(原版注释,勿改)。
// [HF 3] 容器里默认不开 :8899。
const APP_PORT = 8899;
const server = http.createServer(handler);
server.on('error', (err) => {
  bb.write(`[${new Date().toISOString()}] [gateway] SERVER_ERROR :${GW.port} ${(err && err.stack) || err}\n`);
  log(`网关 :${GW.port} 监听失败：${err.message} → 退出`);
  process.exit(1);
});
let appServer = null;
if (!NO_ALIAS) {
  appServer = http.createServer(handler);
  appServer.on('error', (err) => {
    bb.write(`[${new Date().toISOString()}] [gateway] SERVER_ERROR :${APP_PORT} ${(err && err.stack) || err}\n`);
    log(`客户端别名端口 :${APP_PORT} 监听失败：${err.message} → 退出`);
    process.exit(1);
  });
  appServer.listen(APP_PORT, HOST, () => {
    log(`zcode 客户端别名端口已监听 ${HOST}:${APP_PORT}`);
  });
}
server.listen(GW.port, HOST, () => {
  log(`zcode 网关已监听 ${HOST}:${GW.port}，后端 ${ENGINES.length} 个号：${ENGINES.map((e) => e.name + ':' + e.port).join(', ')}`);
  watchEngines();
  watchPool();
});
