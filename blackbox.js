'use strict';
/**
 * blackbox.js — 进程黑匣子：把「进程怎么死的」落盘。
 *
 * 背景（2026-09-28 网关异常终止事件）：zcode-gateway 当天在 11:04~15:29 之间死过一次，
 * 但两个日志里没有任何退出痕迹 —— 网关自己只记主动打的行，崩溃堆栈走 stderr、
 * 被杀没有回调，控制台一关这些信息就全丢了。事后只能靠「日志断流 + 下一条启动横幅」
 * 反推死过，死因永远不可知。本模块补上这个观测缺口。
 *
 * 用法：const bb = require('./blackbox').install({ file, tag });
 *   file  崩溃日志绝对路径（追加写）
 *   tag   条目前缀，区分进程（gateway / guardian / …）
 *
 * 记录的事件：
 *   install            进程启动（带 pid / node 版本 / cwd）
 *   UNCAUGHT_EXCEPTION 未捕获异常 → 落盘后 exit(1)，交给守护进程拉起（干净死，不僵尸）
 *   UNHANDLED_REJECTION 未处理的 Promise 拒绝 → 只落盘不退出（大多数是单请求级故障）
 *   SIGNAL             收到 SIGINT/SIGTERM/SIGHUP/SIGBREAK → 落盘后正常退出
 *   SERVER_ERROR       监听失败（EADDRINUSE 等）→ 落盘后 exit(1)，避免僵尸进程占着坑
 *   EXIT               进程退出（带退出码）
 *
 * 日志文件默认在 zcode/logs/zcode-crash.log，多进程共写一个文件（追加 + 单行原子性
 * 在 Windows 上对小段 append 足够），靠 tag 区分谁写的。
 */
const fs = require('fs');
const path = require('path');

function install({ file, tag }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const write = (line) => {
    try { fs.appendFileSync(file, line); } catch { /* 连崩溃日志都写不进时只能放弃 */ }
  };
  const stamp = () => new Date().toISOString();
  const state = () => {
    try {
      return JSON.stringify({
        pid: process.pid,
        uptime_s: Math.round(process.uptime()),
        rss_mb: Math.round(process.memoryUsage().rss / 1048576),
      });
    } catch { return '{}'; }
  };

  write(`[${stamp()}] [${tag}] install pid=${process.pid} node=${process.version} cwd=${process.cwd()}\n`);

  process.on('uncaughtException', (err) => {
    write(`[${stamp()}] [${tag}] UNCAUGHT_EXCEPTION ${state()}\n${(err && err.stack) || String(err)}\n`);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    write(`[${stamp()}] [${tag}] UNHANDLED_REJECTION ${state()}\n${(reason && reason.stack) || String(reason)}\n`);
  });

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    process.on(sig, () => {
      write(`[${stamp()}] [${tag}] SIGNAL ${sig} ${state()}\n`);
      process.exit(0);
    });
  }

  process.on('exit', (code) => {
    write(`[${stamp()}] [${tag}] EXIT code=${code} ${state()}\n`);
  });

  return { write };
}

module.exports = { install };
