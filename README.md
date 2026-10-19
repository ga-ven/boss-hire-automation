# BOSS 招聘自动化 · 运行手册

> 目标：把「筛选候选人 → 主动打招呼 → 引导加微信」这条日常链路自动化。
>
> 底座：`@joohw/boss-cli`（GPL-3.0）—— 基于 CDP 驱动**本机 Chrome**，复用登录态，数据只存本地 `~/.boss-cli/`，不经第三方服务器。
> **内部自用无碍；对外分发或集成进产品需评估 GPL 开源义务。**

---

## 一、三条铁律（不可协商）

### 1. 加微信只能走平台官方「交换微信」，绝不发微信号

BOSS 官方治理公告原文：

> 「该招聘者高频索要求职者微信，**但并非通过平台交换功能**，而是通过隐晦方式引导求职者至站外沟通，相关账号已被平台处置。」

平台明确表示能识别「**发图片、拼音或变体词暗示微信号**」这类花招。力度参考：2026-03 单月封禁 **1.3 万个**引流账号，其中**约 90% 在求职者举报前就被 AI 主动拦截**。

**风控看的是行为模式，不看你动机是不是真心招聘。** 只要脚本高频发微信号，一样命中。

⇒ 自动化只做 **`boss action wechat`（发起官方交换微信请求）**，永不替人「发微信号」。

### 2. 限速：单轮上限 + 随机间隔

打招呼**要消耗额度**（官方 help 原话："会消耗打招呼次数且单次成本较高"）。默认：单轮 ≤ 5 人、相邻间隔随机 25–70 秒。

### 3. 去重

两个层面都要去重：

- **页面内重复**：BOSS 推荐页会把同一个人渲染两次（实测 30 条 → 实际 15 人）
- **跨天重复**：`state/greeted.json` 记录已打过招呼的人，绝不重复打扰

---

## 二、日常用法

首次使用先准备配置（`config.json` 含业务信息，不进仓库）：

```bash
cp config.example.json config.json
# 然后编辑 config.json，填上你的岗位关键字
```

```bash
cd boss-hire

# 1) 扫描 + 筛选（只读，不消耗任何额度，可以反复跑）
node scripts/scan.mjs

# 2) 看名单（dry-run，不消耗）
node scripts/greet.mjs

# 3) 真发
node scripts/greet.mjs --send              # 受 config.greet.perRunLimit 限制
node scripts/greet.mjs --send --limit 10   # 临时改本次上限
```

筛选条件和上限都在 **`config.json`** 里改，不用动代码：

```jsonc
{
  "jobKeyword": "你的岗位关键字",     // 对应 BOSS 岗位下拉里的名称
  "filters": {
    "expectKeywords": [],            // 期望岗位要命中任一关键词；留空 = 不过滤
    "cityKeywords": [],              // 期望城市要命中任一；留空 = 不过滤
    "excludeContacted": true         // 排除聊天列表里已联系过的人
  },
  "greet": {
    "perRunLimit": 5,                // 单次最多打几个
    "delayMinMs": 25000,             // 相邻两人最小间隔
    "delayMaxMs": 70000,             // 相邻两人最大间隔
    "maxConsecutiveFailures": 3      // 连续失败这么多次就熔断
  }
}
```

产出目录：

```
state/
├── last-scan.json     # 最近一次扫描的完整结果（含被排除的人及原因）
├── greeted.json       # 打招呼状态库（按岗位分组，note: ok / failed）
└── runs/              # 每次运行的明细日志，含 boss-cli 的完整原始输出
```

---

## 三、⚠️ 保活：这套东西最脆弱的一环

**踩过的坑（务必记住）**：

1. `boss login` 会在后台拉起一个**常驻 Chrome**（profile 固定在 `~/.boss-cli/.cache/browser-data`，CDP 端口固定 **53470**），node 进程会一直挂着 —— 这是**正常**的，别去关它。
2. 那个 node 进程会在若干小时后**自行退出**（实测挂了近 6 小时），Chrome 随之关闭。
3. **Chrome 用这个 profile 冷启动要 ~7 分钟**，而 CLI 的等待超时远短于此 ⇒ 会误报「浏览器进程在就绪前退出（代码 21）」。**这不是坏了，是在等它起起来。**
4. **最要命的：登录态不跨 Chrome 重启。** Chrome 一关一开，页面就回到登录页，必须重新扫码。

**⇒ 结论：那个 Chrome 窗口不要关。** 发现命令报「就绪前退出」时，先等几分钟再用，不要急着反复重试。

**排查三连**（都在 git-bash 里跑）：

```bash
# 端口是否就绪（200 = 好了，000 = 还没起来或已关闭）
curl -s --noproxy '*' -m 5 -o /dev/null -w "%{http_code}\n" http://127.0.0.1:53470/json/version

# 当前停在哪个页面（可判断是不是掉登录了）
curl -s --noproxy '*' http://127.0.0.1:53470/json/list
```

```powershell
# 查进程（清理卡死进程时，只杀 node 不杀 Chrome，能省下 7 分钟冷启动）
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*boss-cli*' }
```

**遇到会话锁**（报 `Boss session is busy ... Lock owner: unknown`）：说明有残留锁，
删掉 `C:\Users\PC\.boss-cli\.cache\session.lock` 再重试（确认没有正在跑的 boss-cli 进程后再删）。

---

## 四、命令映射（boss-cli 原生能力）

| 流程步骤 | 命令 | 说明 |
| --- | --- | --- |
| 登录 | `boss login` | 打开登录页，人工扫码；**命令会保持浏览器常驻** |
| 读推荐牛人 | `boss recommend [岗位关键字]` | 进推荐页并读取列表，**不消耗打招呼次数** |
| 常规搜索 | `boss search [关键词]` | 搜索牛人 |
| 深度搜索 | `boss deep-search --core <要求> [--bonus <加分项>] [--match]` | 只有 `--match` 才点「立即匹配」，**会消耗当日匹配次数** |
| **打招呼** | `boss greet <姓名> [--job <岗位>]` | ⚠️ **只对"当前所在页面"生效，不自动跳转** —— 必须先 `recommend` / `deep-search` 进页面。**消耗额度** |
| 查看会话 | `boss list [--unread]` | 聊天列表 |
| 打开会话 | `boss chat <姓名> [--index <序号>] [--unread] [--strict]` | 同名候选人用 `--index` 定位 |
| 发消息 | `boss send --text "..."` | 向当前会话发送 |
| **交换微信** | `boss action wechat` | 走平台官方交换微信（需先打开该候选人会话） |
| 索要简历 | `boss action resume` / `request-attachment-resume` | 后者是工具栏「求简历」，**需双方各至少发过一条消息** |
| 不合适 / 备注 | `boss action not-fit` / `boss action remark --remark "..."` | |
| 简历预览 | `boss preview <姓名>` | **平台限制每日查看次数** |
| 职位 | `boss positions` / `boss jd <名称>` | `positions` 目前报错「进入职位页失败」，待排查 |

**打招呼成功的标志**：输出里出现 `已对 <姓名> 点击"打招呼"。`
**注意**：打招呼后，推荐页上那个人的状态**仍是「可打招呼」**（实测），所以**不能靠页面状态去重，必须靠自己的状态库**。

---

## 五、前置准备清单（人工完成，脚本替不了）

- [ ] 可登录的 **BOSS 直聘企业端（B 端）** 账号
- [ ] 设置 → 账号与安全 → **绑定本人实名微信**（否则交换微信功能不可用）
- [ ] 开启「**简历交换请求提醒**」
- [ ] APP 版本 **≥ 12.80**
- [ ] 聊天窗口能看到「换微信」入口

---

## 六、实测记录

**测试岗位：某教育类岗位**

- 推荐列表 30 条 → 去重后 **15 人**（每人重复 2 次）
- 候选人画像：应届本科为主，教育相关专业
- 聊天列表已有 42 人（自动排重）
- 打招呼链路验证通过（具体人选已脱敏）

**待办**

- [ ] 核实打招呼是否有每日额度上限、上限多少
- [ ] 跑通「交换微信」环节（`boss action wechat`），确认账号是否满足前置条件
- [ ] 核实筛选条件是否需要收紧（目前 `expectKeywords` / `cityKeywords` 为空，等于不筛）
- [ ] 解决保活问题：避免 Chrome 关闭导致每次都要重新扫码
