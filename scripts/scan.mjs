/**
 * 扫描推荐页候选人 → 去重 → 过滤 → 输出候选名单。
 *
 * 只读操作：不打招呼、不消耗任何额度。可以先反复跑，用来调筛选条件。
 *
 * 用法：
 *   node scripts/scan.mjs              # 用 config.json 里的 jobKeyword
 *   node scripts/scan.mjs 地推专员     # 临时指定岗位关键字
 */
import fs from 'node:fs';
import path from 'node:path';
import { boss, ROOT, readConfig } from './lib/boss.mjs';

const cfg = readConfig();
const JOB = process.argv[2]?.trim() || cfg.jobKeyword;

// ---------------- 解析 ----------------

/** 解析 boss recommend 的输出 */
function parseRecommend(text) {
  const items = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    const m = line.match(
      /^\s*-\s*(\d+)\.\s*(.+?)\s*｜\s*薪资[:：](.*?)\s*｜\s*信息[:：](.*?)\s*｜\s*期望[:：](.*?)\s*｜\s*(可打招呼|已打招呼)\s*$/,
    );
    if (m) {
      cur = {
        idx: Number(m[1]),
        name: m[2].trim(),
        salary: m[3].trim(),
        info: m[4].trim(),
        expect: m[5].trim(),
        status: m[6],
        advantage: '',
      };
      items.push(cur);
      continue;
    }
    const a = line.match(/^\s*优势[:：]\s*(.*)$/);
    if (a && cur) cur.advantage = a[1].trim();
  }
  return items;
}

/** 解析 boss list 的输出，只取姓名 */
function parseChatList(text) {
  const names = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^\s*(\d+)\.\s*(.+?)\s*｜\s*(.+?)\s*｜/);
    if (m) names.push(m[2].trim());
  }
  return names;
}

// ---------------- 主流程 ----------------

console.log(`[scan] 读取推荐列表：${JOB}`);
const rec = boss(['recommend', JOB]);
const all = parseRecommend(rec.text);

if (all.length === 0) {
  console.error('[scan] 没能从推荐页解析到候选人。原始输出如下：');
  console.error(rec.text);
  process.exit(1);
}

// 去重：BOSS 推荐页会把同一个人渲染两次
const dedup = new Map();
for (const it of all) {
  const key = `${it.name}|${it.salary}|${it.info}`;
  if (!dedup.has(key)) dedup.set(key, { ...it, dupCount: 1 });
  else dedup.get(key).dupCount += 1;
}
const uniq = [...dedup.values()];

// 已联系名单
let contacted = new Set();
if (cfg.filters.excludeContacted) {
  const ls = boss(['list']);
  contacted = new Set(parseChatList(ls.text));
}

// 过滤
const { expectKeywords, cityKeywords } = cfg.filters;
const hit = [];
const skipped = [];
for (const p of uniq) {
  const reasons = [];
  if (p.status !== '可打招呼') reasons.push(`状态=${p.status}`);
  if (expectKeywords.length && !expectKeywords.some((k) => p.expect.includes(k)))
    reasons.push('期望岗位不匹配');
  if (cityKeywords.length && !cityKeywords.some((k) => p.expect.includes(k)))
    reasons.push('城市不匹配');
  if (contacted.has(p.name)) reasons.push('已在聊天列表（已联系过）');

  if (reasons.length) skipped.push({ ...p, reasons });
  else hit.push(p);
}

// ---------------- 输出 ----------------

console.log('');
console.log(`[scan] 推荐页原始 ${all.length} 条 → 去重后 ${uniq.length} 人`);
console.log(`[scan] 通过筛选 ${hit.length} 人，被排除 ${skipped.length} 人`);
if (cfg.filters.excludeContacted)
  console.log(`[scan] 聊天列表已有 ${contacted.size} 人，用于排重`);
console.log('');

if (hit.length) {
  console.log('=== 待打招呼 ===');
  hit.forEach((p, i) => {
    console.log(`${i + 1}. ${p.name}｜${p.salary}｜${p.info}`);
    console.log(`   期望：${p.expect}`);
    if (p.advantage) console.log(`   优势：${p.advantage.slice(0, 70)}`);
  });
  console.log('');
}

if (skipped.length) {
  console.log('=== 已排除 ===');
  for (const s of skipped) {
    console.log(`- ${s.name}（${s.reasons.join('，')}）`);
  }
  console.log('');
}

// 落盘，供 greet 使用
const outDir = path.join(ROOT, 'state');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'last-scan.json');
fs.writeFileSync(
  outFile,
  JSON.stringify({ scannedAt: new Date().toISOString(), job: JOB, hit, skipped }, null, 2),
  'utf8',
);
console.log(`[scan] 结果已写入 ${path.relative(ROOT, outFile)}`);
console.log('[scan] 本次为只读操作，未消耗任何打招呼额度。');
