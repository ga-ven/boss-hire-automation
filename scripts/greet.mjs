/**
 * 对扫描结果里的候选人自动打招呼。
 *
 * ⚠️ 这是**消耗额度**的动作（官方 help：会消耗打招呼次数且单次成本较高）。
 *    所以默认 dry-run，必须显式加 --send 才会真发。
 *
 * 用法：
 *   node scripts/greet.mjs                    # dry-run：只打印将要打招呼的名单
 *   node scripts/greet.mjs --send             # 真发，受 config.greet.perRunLimit 限制
 *   node scripts/greet.mjs --send --limit 2   # 临时改本次上限
 */
import fs from 'node:fs';
import path from 'node:path';
import { boss, ROOT, readConfig, sleep, randInt } from './lib/boss.mjs';

const argv = process.argv.slice(2);
const SEND = argv.includes('--send');
const limitIdx = argv.indexOf('--limit');
const limitArg = limitIdx >= 0 ? Number(argv[limitIdx + 1]) : null;

const cfg = readConfig();
const LIMIT = Number.isFinite(limitArg) ? limitArg : cfg.greet.perRunLimit;
const MAX_FAIL = cfg.greet.maxConsecutiveFailures ?? 3;

const STATE_DIR = path.join(ROOT, 'state');
const SCAN_FILE = path.join(STATE_DIR, 'last-scan.json');
const GREETED_FILE = path.join(STATE_DIR, 'greeted.json');
const LOG_DIR = path.join(STATE_DIR, 'runs');

// ---------------- 读扫描结果 ----------------

if (!fs.existsSync(SCAN_FILE)) {
  console.error('[greet] 没找到 state/last-scan.json，请先跑：node scripts/scan.mjs');
  process.exit(1);
}
const scan = JSON.parse(fs.readFileSync(SCAN_FILE, 'utf8'));
const ageMin = Math.round((Date.now() - new Date(scan.scannedAt).getTime()) / 60000);
if (ageMin > 60) {
  console.warn(`[greet] 注意：扫描结果是 ${ageMin} 分钟前的，名单可能已过期，建议重跑 scan。`);
}

// ---------------- 读状态库 ----------------

const greeted = fs.existsSync(GREETED_FILE)
  ? JSON.parse(fs.readFileSync(GREETED_FILE, 'utf8'))
  : {};
const jobState = (greeted[scan.job] ??= {});

// 只把「成功过」的视为已处理；失败过的要允许重试
// （典型失败原因是会话锁冲突、页面未就绪等暂时性问题）
const known = scan.hit.filter((p) => jobState[p.name]?.note === 'ok');
const queue = scan.hit.filter((p) => jobState[p.name]?.note !== 'ok');

console.log(
  `[greet] 扫描结果：通过筛选 ${scan.hit.length} 人，状态库已记录 ${known.length} 人，待处理 ${queue.length} 人`,
);
console.log(`[greet] 本次上限 ${LIMIT} 人｜模式：${SEND ? '【真发·消耗额度】' : 'dry-run（不消耗）'}`);
console.log('');

const todo = queue.slice(0, LIMIT);

if (todo.length === 0) {
  console.log('[greet] 没有需要处理的候选人。');
  process.exit(0);
}

console.log('待打招呼名单：');
todo.forEach((p, i) => console.log(`  ${i + 1}. ${p.name}｜${p.salary}｜${p.expect}`));
console.log('');

if (!SEND) {
  console.log('[greet] dry-run 结束。确认名单无误后，加 --send 真发。');
  process.exit(0);
}

// ---------------- 真发 ----------------

// greet 只对「当前所在页面」生效，先把页面导到推荐页
console.log(`[greet] 先把页面导到推荐页：${scan.job}`);
const nav = boss(['recommend', scan.job], { timeoutMs: 240_000 });
if (/失败|错误/.test(nav.text.split(/\r?\n/)[0] ?? '')) {
  console.error('[greet] 进入推荐页失败，中止。原始输出：');
  console.error(nav.text.slice(0, 400));
  process.exit(1);
}

fs.mkdirSync(LOG_DIR, { recursive: true });
const runLog = [];
let consecutiveFail = 0;

for (let i = 0; i < todo.length; i++) {
  const p = todo[i];
  console.log(`[greet] (${i + 1}/${todo.length}) 打招呼：${p.name}`);

  const r = boss(['greet', p.name, '--job', scan.job], { timeoutMs: 240_000 });
  const ok = /已对.+点击[“"]打招呼[”"]/.test(r.text);
  // 输出首行通常是「当前岗位：…」，真正有用的结果行在后面，优先取它
  const lines = r.text.split(/\r?\n/).filter((l) => l.trim());
  const resultLine =
    lines.find((l) => /已对|已打招呼|失败|无法|未找到|弹层|权益/.test(l)) ?? lines[0] ?? '(无输出)';

  runLog.push({ name: p.name, at: new Date().toISOString(), ok, output: r.text.slice(0, 600) });

  if (ok) {
    consecutiveFail = 0;
    jobState[p.name] = { greetedAt: new Date().toISOString(), note: 'ok' };
    console.log(`[greet]   ✅ ${resultLine}`);
  } else {
    consecutiveFail += 1;
    jobState[p.name] = { greetedAt: new Date().toISOString(), note: 'failed', error: resultLine };
    console.log(`[greet]   ❌ ${resultLine}`);
    if (consecutiveFail >= MAX_FAIL) {
      console.log(
        `[greet] 连续失败 ${consecutiveFail} 次，熔断停止（避免在异常状态下空转或触发风控）。`,
      );
      break;
    }
  }

  // 每步都落盘，中断也不丢进度
  fs.writeFileSync(GREETED_FILE, JSON.stringify(greeted, null, 2), 'utf8');

  if (i < todo.length - 1) {
    const wait = randInt(cfg.greet.delayMinMs, cfg.greet.delayMaxMs);
    console.log(`[greet]   等待 ${Math.round(wait / 1000)} 秒…`);
    await sleep(wait);
  }
}

// ---------------- 汇总 ----------------

const okCount = runLog.filter((x) => x.ok).length;
const logFile = path.join(LOG_DIR, `greet-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(logFile, JSON.stringify(runLog, null, 2), 'utf8');

console.log('');
console.log(`[greet] 完成：成功 ${okCount}，失败 ${runLog.length - okCount}`);
console.log(`[greet] 明细：${path.relative(ROOT, logFile)}`);
console.log(`[greet] 状态库：${path.relative(ROOT, GREETED_FILE)}`);
