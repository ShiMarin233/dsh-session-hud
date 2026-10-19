# dsh-session-hud

> **English summary** — A session-status desktop pet for DeepSeek Harness (`dsh`).
> A small animated pet sits in the bottom-right corner; clicking it opens a bubble with three live
> counts: **running** sessions, **completed-but-unread** sessions, and sessions **waiting for your
> choice** (approval / plan review / question). Clicking a count jumps to that session; clicking the
> same row repeatedly cycles through the sessions in that group.
> Zero npm dependencies, no host-side behaviour: everything is one self-contained client bundle
> (`lib/client.js`, pet animations inlined as base64). Build with `node tools/build.mjs`.
> Third-party content and licensing: see [`NOTICE.md`](./NOTICE.md). MIT.

DSH 会话状态挂件：右下角一只安静的宠物角标，单击展开气泡，实时显示你要的三个数字 ——

```
🌊 3 个在跑
✅ 1 个没看          ← 后台跑完、你还没打开过的
⚠️ 2 个等你选 (1 确认 · 1 提问)   ← 需要你手动做选项选择的
```

单击任一数字行 → 直接跳进对应会话；同类多个会话时**连续单击依次轮换**（右下角会提示 `2/3，再点下一个`）。

---

## 一、数据从哪来（全部是 DSH 原生服务，事件驱动、零轮询）

| 数字 | 来源 | 判定 |
|---|---|---|
| **进行中** | `uiSession.sessionStatus` **＋** `sessions.list.projectionsBySession` | 会话自己 `running === true`，**或**它名下还有 running 的**直接**子代理（`runningChildCount > 0`） |
| **完成未读** | `uiSession.sessionStatus` | 会话自己的 `completionUnread === true`（**只**看主会话；子代理跑完不算） |
| **待你选择** | `uiSession.sessionStatus` | 会话自己的 `pendingInteraction !== undefined`，**或**它名下**直接**子代理的 `pendingInteraction`（v0.6.0，**与侧栏有意分叉**，见 §1.2） |

`sessionStatus.getSnapshot()` 返回 `Map<sessionId, { running, pendingInteraction, completionUnread }>`，
这是 DSH 0.2.0 的**统一会话状态面**（取代了旧的 pendingInteractions），实现在官方包
`@deepseek-ai/dsh-client-ui-session`（源码注释原文：*"Root source combining running,
pending-interaction, and completion-reminder facts"*）。

`pendingInteraction.kind` 的三分类（口径与 `dsh-activity-pane` 一致）：

| kind | 含义 |
|---|---|
| `approval` | 待确认授权 |
| `plan-review` | 待审查计划 |
| `question` | 待回答问题 |

其余服务：`sessions.list`（会话行，用于标题与排序）、`workspaces.list`（归档过滤）、
`uiWorkspace.openSession(id)`（跳转）。

**统计口径**：只算主会话 —— 排除 `origin === "subagent"`（子代理）、`blank`（空白会话）、
已归档会话。与官方侧栏及活动面板一致。

**「进行中」是聚合口径**（v0.4.0 修，之前只数主会话自己的 `running`，于是主智能体空闲、
子代理还在跑时侧栏转圈而桌宠报 0）。官方侧栏 `lib/.../Rows.js` 的表达式是：

```js
// runningChildCount(list, parentId, statuses)
list.projectionsBySession[parentId]?.values.subagentCatalog
  ?.reduce((n, child) => n + ((statuses.get(child.id)?.running ?? list.byId[child.id]?.running) === true ? 1 : 0), 0) ?? 0
// sessionStatuses(): node.running === true 或 runningSubagentCount > 0 → ongoing（转圈）
```

本插件用 `runningChildCount()`（`src/widget.js`）实现同一表达式，只数**直接**子级
（孙辈算在它自己的父会话上，而那个父会话不是侧栏的行 —— 与侧栏严格对齐）。
拿不到 `projectionsBySession` 或形状异常时返回 0，退化为原行为，不抛异常。

> `completionUnread` 的语义（v0.5.0 从 asar 逐行查清，官方实现）：
> ```js
> // 471629
> isMain(id) { return (this.sessions.list.getSnapshot().byId[id]?.retainedBy.mainView ?? 0) > 0 }
> // 718647  source:"mainView" 只在 uiWorkspace.openSession 里 retain
> const reference = this.sessions.retain(target, { source: "mainView" })
> // 471603-471609
> observeRunning(sessionId, running) {
>   const previous = this.running.get(sessionId)
>   const beforeBaseline = this.sessions.list.getSnapshot().phase === "pending"
>   this.running.set(sessionId, running)
>   if (running) this.completionUnread.delete(sessionId)
>   else if ((previous === true || previous === void 0 && beforeBaseline) && !this.isMain(sessionId)) this.completionUnread.add(sessionId)
>   this.publishStatus()
> }
> // 471620  reconcileStatus 只清除 isMain 的那一个
> for (const id of present) if (this.isMain(id)) this.completionUnread.delete(id)
> ```
> **`isMain` 不是「`origin === 'main'`」，而是「你当前打开的那一个会话」**（`mainView`
> 引用同一时刻只属于一个会话）。所以：
> - 你在会话 X 里，会话 Y 跑完 → **Y 置位** → 侧栏 Y 显示 `status.completed`「已完成」
>   （718135 / 719101，字典 721643），桌宠「完成未读」+1 ✅
> - 你正开着 Y、Y 跑完 → **不置位**（你已经在看了）
> - Y 重新跑起来 / 从列表消失 → 清除
>
> 这条曾被怀疑是「对主会话恒为 false 的死信号」，**已证伪**：它是有消费者的活信号。
> `tools/smoke.mjs` 有专门用例把它钉住（非主视图计数、主视图不计数）。
>
> ⚠️ **子代理的 `completionUnread` 谁都不显示**：子代理不是侧栏的行，
> `runningChildCount` 也只数 *running* 的子代理。所以「某个子代理跑完了」在官方 UI 里
> **没有任何信号**（侧栏状态字典 721633-721643 里没有这一项）。按用户裁决，桌宠**也不**
> 把它算进「完成未读」（规则②：只有**主代理**跑完才算），加了就违背裁决。
>
> 注意区分：子代理的 **pending**（在等你交互）**已经算了**（v0.6.0，规则③，见 §1.2）；
> 子代理的 **completion**（跑完了）**不算**（规则②）。

### 1.1 多状态组合矩阵（v0.5.0 穷举并钉住）

官方侧栏的状态词表就这 7 条（asar `721633-721643`）：
`status.running` 进行中 / `status.subagentsRunning` 子智能体运行中 / `status.idle` 空闲 /
`status.waitingApproval` 等待审批 / `status.planReview` 计划待审 / `status.waitingAnswer` 等待回答 /
`status.completed` 已完成 —— **没有「排队输入」之类的状态**（`QueueDock` 的 `queue.count` 属于对话区，418359）。

桌宠气泡是**三行独立计数**，不是 `if/else` 链，所以多状态共存时不丢信息。
唯一的 `if/else` 链是角标（只有一位数字），优先级与侧栏 `statuses[0]` 同序（719092-719108）。

| 组合 | 自身 running | 子代理 running | completionUnread | pendingInteraction | 进行中 | 完成未读 | 待选择 | 情绪 | 角标 |
|---|---|---|---|---|---|---|---|---|---|
| R | ✅ | — | — | — | 1 | 0 | 0 | busy | 1/run |
| S | — | ✅ | — | — | 1 | 0 | 0 | busy | 1/run |
| R+S | ✅ | ✅ | — | — | **1**（同一会话不重复计） | 0 | 0 | busy | 1/run |
| C | — | — | ✅ | — | 0 | 1 | 0 | celebrate | 1/done |
| P:approval | — | — | — | approval | 0 | 0 | 1 | waiting | 1/wait |
| **R+P:question** | ✅ | — | — | question | **1** | 0 | **1** | waiting | 1/wait |
| **S+P:plan-review** | — | ✅ | — | plan-review | **1** | 0 | **1** | waiting | 1/wait |
| **S+P(child 持有)**（v0.6.0） | — | ✅ | — | **子代理** question | **1** | 0 | **1** | waiting | 1/wait |
| **P(main)+P(child)**（v0.6.0） | — | ✅ | — | main approval **+** child question | 1 | 0 | **2** | waiting | 2/wait |
| S+C | — | ✅ | ✅ | — | 1 | **1** | 0 | busy | 1/run |
| P+C | — | — | ✅ | approval | 0 | 1 | 1 | waiting | 1/wait |
| R+P+C（官方不可能） | ✅ | — | ✅ | approval | 1 | 1 | 1 | waiting | 1/wait |
| P:unknown-kind | — | — | — | 未知 | 0 | 0 | 1 | waiting | 1/wait |
| 孙辈在跑 | — | 孙辈 | — | — | **0**（只数直接子级） | 0 | 0 | dozing | 0/— |
| 孙辈 pending（v0.6.0） | — | 孙辈 | — | 孙辈 question | **0**（只数直接子级） | 0 | **0** | dozing | 0/— |
| C(child 持有)（规则②） | — | — | **子代理** | — | 0 | **0**（子代理跑完不算） | 0 | dozing | 0/— |
| Q:排队输入 | ✅ | — | — | — | 1 | 0 | 0 | busy | 1/run |
| 混合 5 会话 | 3 个 | 1 个 | 1 个 | 2 个 | 3 | 1 | 2 | waiting | 2/wait |

### 1.2 规则③：子代理的待交互也算「等我选」（**有意与侧栏分叉**）

用户 2026-10-16 明确裁决：

> 我觉得桌宠显示的应该是，如果这个对话确实没进行完，**无论是主代理还是子代理，都应该挂着在跑**，
> 只有**主代理跑完了但我没点开**才会标明没看，**无论主代理或者子代理需要我交互选项卡来选择内容/一定需要我回复内容就算做等我选**

三条规则落地成：

| 数字 | 规则 | 与官方侧栏 |
|---|---|---|
| 进行中 | 主会话在跑 **OR** 直接子代理在跑 | **同口径**（`runningSubagentCount`） |
| 完成未读 | **只**看主会话自己的 `completionUnread`；子代理跑完**不算** | 同口径 |
| 待你选择 | 主会话自己的 pending **OR** 直接子代理的 pending | ⚠️ **有意分叉** |

**侧栏不显示子代理的 pending。** 依据是 `718128`：

```js
const pendingInteraction = visiblePendingKind(status?.pendingInteraction?.kind)  // 只看会话自己
```

而桌宠 v0.6.0 起把**直接子代理**的 pending 也算进来。分叉是**明示的取舍**，不是失手 ——
因为「子代理卡在问你问题」这件事，侧栏只会显示「N 个子智能体运行中」（`status.subagentsRunning`），
看不出它在等你。

**子代理的 pending 从哪读**（取证，全部 asar 行号）：

```js
// 336653  每个会话（含子代理会话）都有自己一个 scope，标签就是它的 session id
const { fiber, ctx } = createScope(this.rootCtx, id)      // ClientSessions.materializeScope(id)
// 336567  scopeOf 就是把那个标签读回来
scopeOf(ctx) { return scopeTagOf(ctx) }                    // import ... from "../scope.js"

// 386458  approval：登记在**请求方 agent 的会话**名下
const sessionId = ctx.sessions.scopeOf(owner)              // owner = $on 监听器的 scoped ctx
const pending = new PendingApproval(sessionId, {...})      // 386326 sessionId / 386353 kind="approval"

// 715845  question：同一模式
const sessionId = ctx.sessions.scopeOf(owner)
const card = cards.ensure(sessionId, request.questions, callId)   // 714228 PendingQuestion.sessionId
                                                                 // 714224 kind

// 471591-471596  公开 Map 按 interaction.sessionId 归档（**每个 sessionId 只留一个 pending**）
const precedence = domain.precedence(interaction)
if (previous === void 0 || precedence >= previous.precedence) next.set(interaction.sessionId, { interaction, precedence })

// 471631-471643  汇进同一张 uiSession.sessionStatus
const ids = new Set([
  ...Object.keys(this.sessions.list.getSnapshot().byId),   // ← 子代理行也在里面（336695-336741）
  ...this.running.keys(), ...this.pendingSnapshot.keys(), ...this.completionUnread
])
for (const id of ids) next.set(id, { running: ..., pendingInteraction: this.pendingSnapshot.get(id), completionUnread: ... })
```

**所以子代理的 pending 一直在桌宠已经握着的那张 Map 里**，key 就是子会话 id ——
v0.3.0~v0.5.0 之所以读不到，只是因为 `readState` 的 `rows` 白名单把 `origin === 'subagent'`
整行滤掉了（和 v0.3.0 漏掉子代理 `running` 是**同一个根因**）。
**不需要新服务、不需要新订阅。**

**去重**（三重保证，不重复计）：
1. `publishPendingInteractions` 按 `sessionId` 归档 → **一个 sessionId 最多贡献 1**；
2. 子代理行不在 `rows` 里（`origin === 'subagent'` 被滤），主会话的循环**不可能**碰到它；
3. 代码里还有一层 `seen: Set<sessionId>` —— 即使目录形状异常导致同一 id 被走到多次也只算一次。

**跳转**：子代理的条目挂**子会话自己的 id + row**（不是父会话），所以点「个等你选」
会直接跳到那个真正挂着交互面板的会话（approval/question 面板注册在 `conversation.composer`
且 `scope: "session"`，即在子会话里）。标题取 `byId[childId].displayTitle`，
拿不到就用目录里的 `label`，再不行退 id。

**角标 / 情绪**（未改优先级，只是分母变大）：
- 角标本来就是 `badgeN > 9 ? '9+' : String(badgeN)` —— **不会溢出**，两位数以上显示 `9+`。
- `pickEmotion` 的 `pending > running > unread > dozing` **没动**。子代理在等你也确实是
  「需要你」的最强信号，排第一仍然合理。
- 气泡三行结构、`byKind` 明细（如 `(1 确认 · 1 提问)`）照旧，子代理的 pending 也计入 `byKind`。

> `S+C` / `P+C` 这两行是**刻意的口径差异**：侧栏 `sessionStatuses()` 在 pending 或 subagents
> 命中后会 `early return`（719092-719100），把 `completed` 吞掉；桌宠三行独立，两个都显示。
> 这是桌宠**多给信息**（不是错），已用测试钉住。
>
> `P:unknown-kind` 也是刻意的：侧栏 `visiblePendingKind()` 只认三种官方 kind、其余返回
> `undefined` 直接隐藏；桌宠按 `PENDING_UNKNOWN`「待处理」照常计数（宁可见一个可疑数字，
> 也不要静默吞掉一个真实交互）。官方 union 是封闭的，实际不会出现。

---

## 二、扩展接口（留给后续功能）

### 2.1 往气泡里加内容（例如「个人日程播报」）

气泡渲染时会把「三数字」之后的位置留给注册进来的提供者。任何插件（或你自己在
控制台里）都能注册：

```js
window.__dshSessionHud.registerBubbleSource({
  id: 'schedule',              // 唯一 id
  order: 100,                  // 越小越靠上，默认 50
  getLines: (state) => [       // 每次渲染都会调用；state = { running, unread, pending, byKind, counts }
    { icon: '📅', text: '14:00 组会', sub: '会议室 A' },
    { icon: '⏰', text: '18:00 交周报', onClick: (s) => console.log('点了', s.counts) }
  ]
})
// 返回的函数用于注销
```

返回的行支持 `{ icon, text, sub, onClick(state) }`；`onClick` 留空则不可点。

### 2.2 其它已暴露的接口

```js
window.__dshSessionHud.version              // 版本号
window.__dshSessionHud.state                // 当前三分类明细（含每个会话的 id/row/kind）
window.__dshSessionHud.refresh()            // 手动重渲染
window.__dshSessionHud.credit               // 素材署名
window.__dshSessionHud.emotions             // 可用情绪键列表
window.__dshSessionHud.show(true/false)     // 展开/收起气泡
window.__dshSessionHud.open(sessionId)      // 跳转会话
window.__dshSessionHud.unmount()            // 卸载
```

调试：`localStorage.setItem('dsh-session-hud:debug','1')` 打开控制台日志。

---

## 三、后期想加活动/花活：去哪参考（**本节所列插件均未被本包使用**）

> ⚠️ 这一节是**将来的备查清单**，不是"已用素材清单"。
> 本包实际使用的第三方内容**只有** `dsh-pet` 的 5 个动画，逐项声明见 [`NOTICE.md`](./NOTICE.md)。

当前是**安静角标 + 一点点动态**：宠物播**动图 WebP**（`<img>` 直接播放），
按状态在「等选择 / 在跑 / 完成未读 / 空闲」四个动画间切换，拖拽时播拖拽动画。
角标数字不弹跳、宠物不跟随鼠标、无音效。想加东西时按下面的表去找参考：

| 想加的功能 | 参考插件 | 具体在哪 |
|---|---|---|
| 角标数字变化时弹一下、跟着身体起伏 | **`pet-whale`** (nzl153, MIT) | `lib/client.js` 里 `.dsh-whale-badge` 的 CSS（第 610 行起，含 `pw-badgePop` / `pw-badgeSway` 关键帧）与 `badge.classList.add('pop')` 的触发 |
| 头顶滚动显示模型的思考流（最近 200 字） | **`pet-whale`** | README「思考流」一节 + client 里 think 状态的 ticker |
| 宠物跟随鼠标、屏幕漫游、可甩晕、压扁、摸头 | **`pet-whale`** / **`dsh-pet`** (PC2005-cloud, MIT) | pet-whale 纯 DOM/SVG 好读；dsh-pet 有 97 个手绘风透明动画 |
| 更多动画：从 `dsh-pet` 的 106 个里再挑 | `dsh-pet` 素材包 + `convert-pet.py` | 改脚本里的 `PICKS` 即可，情绪键自己起名 |
| 更成熟的气泡系统（可编辑内容、点击序列、并列加权 A/B、随机台词/图片、逐行字体） | **`dsh-whale-widget`** (MeteorNOX) | **代码 MIT 可以用**；`assets/**` 作者声明**不适用 MIT、不授予再许可**，图/音效不要拿 |
| 每会话卡片：进度 %、token/s、耗时、模型、推理级别、子代理层级、提问内容预览、后台任务 roster | **`dsh-activity-pane`** (MIT) | `src/core.mjs` 的 `buildEntries()` / `statsFromProjection()` / `pendingText()`；客户端 `src/client.mjs` 取数段 |
| 加设置页（皮肤/大小/透明度/开关） | **`dsh-personal-center`** (PolinniZhong, MIT) | 它的「个人配置」分区写法：`ctx.slots.inject("settings.section", ...)` |
| 日程播报等自有数据 | 本包 `registerBubbleSource` | 见上文 2.1 |

---

## 四、素材来源与许可

宠物动画素材来自 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)：

- 作者 **PC2005-cloud**，**MIT License**
- 原始素材是 640×360、带 alpha 的 **VP9 webm 透明动画**（该仓库 README 载明：素材由
  「AI 提示词 → 绿幕视频 → 透明动画」的**可复现素材链**生成，图像由豆包生成）
- 本包用 `agent-work/convert-pet.py` **裁掉透明边并转成带 alpha 的动图 WebP**，画面内容未改动

情绪键 → 原动画名：

| 键 | 原动画 | 用途 |
|---|---|---|
| `dozing` | 待机呼吸休闲 | 空闲（默认）|
| `busy` | 写代码 | 有会话在跑 |
| `waiting` | 工作状态-原地踱步张望 | 有会话等你选择 |
| `celebrate` | 工作状态-雀跃庆祝 | 有完成未读 |
| `drag` | 被鼠标拖拽悬空反馈 | 正在拖拽挂件 |

本插件自身代码同样 **MIT**。完整的三方内容声明（用了什么 / 没用什么 / 只参考了什么，含核验命令）见 [`NOTICE.md`](./NOTICE.md)。

### 转换时踩的坑（改素材时会用到）

**VP9 的 alpha 存在 WebM 的 `BlockAdditional` 边流里，`ffprobe` 只会报 `yuv420p`。**
必须把 `-c:v libvpx-vp9 -strict experimental` 放在 **`-i` 之前**（输入侧解码器选项），
输出再指定 `-pix_fmt yuva420p`，透明通道才出得来；放错位置会得到全不透明的帧。

另外三个坑：
- **不要用 `select` 滤镜定位取帧** —— 实测它会把带 alpha 的 `gbrap` 转成无 alpha。
  用 `-ss <时间>` 放在 `-i` 之前定位。
- **VP9 的 alpha 是有损的**，边缘会有 alpha=1..8 的噪点。求透明包围盒前必须给 alpha
  设阈值（脚本里用 `> 24`），否则 `getbbox()` 会抓到噪点、包围盒等于整帧、裁切失效。
- **别用 ffmpeg 直接转动画 WebP**。它写出的每一帧都是 `blend=0 / dispose=0`
  （"与上一帧 alpha 混合 + 画完不清除"），浏览器会把**每一帧叠在上一帧上**，
  表现为残影糊成一团。本插件改用 **Pillow**（底层 libwebp 的 `WebPAnimEncoder`，
  会自动为透明帧选 `dispose`）编码，出厂的 5 个文件复核结果都是 `dispose=1`。
  `tools/build.mjs` 现在会**解析 ANMF 帧标志**做回归闸门，一旦发现全帧
  `blend=0/dispose=0` 就直接构建失败。诊断脚本见 `agent-work/webp-anim-diag.py`。

### 为什么内联而不是走宿主回环路由

`dsh-personal-center` 用 `webServer` 回环路由送图，并且只答 `127.0.0.1`。而本机 DSH 是
从手机 / Tailscale 访问的 —— 回环路由在那些客户端上**拉不到图**。内联进 client bundle
则随已鉴权的页面一起下发，任何客户端都能显示，也不需要申请任何宿主路由权限。

代价是 bundle 变大（当前约 4.8MB：5 个动图 WebP，176px 宽 / 8fps / q45）。

---

## 五、构建与改素材

```bash
# 只改逻辑：编辑 src/widget.js，然后
node tools/build.mjs

# 换素材：把新的动图 WebP 放进 assets/pet/<情绪键>.webp，重跑构建
#   （脚本会按文件名当情绪键，缺哪个会告警）
# 想从别的 webm 动画转：改 agent-work/convert-pet.py 里的 PICKS 与 WIDTH/FPS/QUALITY
```

`lib/client.js` 是**生成产物**，不要直接编辑 —— 它由 `src/widget.js` + 内联素材拼接而成。

体积参考：5 个动图 176px 宽 / 8fps / q45 ≈ 3.6MB，内联后 bundle ≈ 4.8MB。
嫌大就降两档（在 `agent-work/convert-pet.py` 里改）：
`WIDTH=128` → ≈3.1MB；`WIDTH=176, FPS=6` → ≈3.6MB；`WIDTH=200, FPS=6` → ≈4.2MB。
挂件盒子当前 **141px**（`src/widget.js` 的 `HUD_SIZE`，CSS 直接引用它，改一处即可）。
嫌大可把 `convert-pet.py` 的 `WIDTH` 降到 96、`FPS` 降到 6。

### 为什么是单文件

DSH 的客户端模块系统把每个 bundle 当 factory 注册（`window.__ModuleLoader__.load({id, factory})`），
external 只解析冻结的基座模块表 —— 相对 `import` 不在表里。所以素材与逻辑必须拼进同一个
文件，运行时形状照抄官方 bundle。

---

## 六、已知边界

- **子代理不单独占一行**：三个数字都是「一个数字 = 一个会话」，只是判定聚合了直接子级。
  「进行中」把 running 的直接子代理算在**父会话**头上（与官方侧栏 `runningSubagentCount`
  同口径）；「待你选择」把子代理的 pending 也聚合进来，但**条目挂子会话自己的 id**
  （v0.6.0，规则③，见 §1.2）—— 这是**与侧栏有意的分叉**，依据用户 2026-10-16 的裁决。
- **只数直接子级**：孙辈子代理不额外计入祖父会话 —— 官方侧栏也是这个口径。
  如果你更想要「整个后代树只要有人在跑/在等就算」，把 `runningChildCount` 与
  规则③那段目录扫描改成递归即可（注意那会进一步与侧栏分叉）。
- **`sessionStatus` 是进程本地投影**：浏览器重连后，未完成的 pending 请求需要宿主重放
  （官方已知限制）。极端情况下刚重连时数字可能短暂偏小。
- 老宿主没有 `sessionStatus` 时自动退化成只看会话摘要的 `running`（见 `readState` 的 else
  分支）；子代理活跃度仍然尝试从 `projectionsBySession` 读，读不到就是退化前的行为。
  **此时「待你选择」会归 0**（pending 全在 `sessionStatus` 里，拿不到就是拿不到）。
- `projectionsBySession` / `subagentCatalog` 形状异常或缺失时 `runningChildCount()` 与规则③
  的子代理扫描一律当空处理，绝不抛异常（那会打断整次 render）。
- 位置存 `localStorage`（键 `dsh-session-hud:prefs`）。