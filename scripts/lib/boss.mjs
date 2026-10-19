/**
 * boss-cli 调用封装。
 *
 * 为什么不用 node_modules/.bin/boss.cmd：
 *   Windows 下 .cmd 要经 cmd.exe 转义，参数里带中文/特殊字符容易出错。
 *   这里直接用当前 node 执行包入口（ESM），参数以数组传入，零转义。
 *
 * 为什么不按退出码判断成败：
 *   boss-cli 失败时通常仍以退出码 0 返回（错误打印在 stdout），
 *   所以这里只取文本，由调用方按内容判断。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');

export const CLI_ENTRY = path.join(
  ROOT,
  'node_modules',
  '@joohw',
  'boss-cli',
  'dist',
  'cli',
  'index.js',
);

/** 执行 boss 子命令，返回 { text, status, timedOut } */
export function boss(args, { timeoutMs = 180_000 } = {}) {
  const r = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  return { text, status: r.status, timedOut: r.error?.code === 'ETIMEDOUT' };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const randInt = (min, max) =>
  min + Math.floor(Math.random() * (max - min + 1));

/** 读取 config.json（相对项目根） */
export function readConfig() {
  const p = path.join(ROOT, 'config.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
