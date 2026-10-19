/**
 * 冒烟测试：在 Node 里用最小 DOM 桩加载 lib/client.js，
 * 验证 (1) 能解析 (2) 导出 apply/inject (3) apply 不抛 (4) 三个数字渲染正确
 *      (5) registerBubbleSource 扩展接口可用。
 *
 * 用法: node tools/smoke.mjs
 */

/* ── 最小 DOM 桩 ───────────────────────────────────────────── */
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.dataset = {}
    this.style = {}
    this.attrs = {}
    this.listeners = {}
    this._text = ''
    this.isConnected = true
    this.classList = { add() {}, remove() {}, contains: () => false }
  }
  set className(v) { this.attrs.class = v }
  get className() { return this.attrs.class ?? '' }
  set id(v) { this.attrs.id = v }
  get id() { return this.attrs.id ?? '' }
  set textContent(v) { this._text = String(v); this.children = [] }
  get textContent() { return this._text || this.children.map((c) => c.textContent).join('') }
  set innerHTML(v) { this._html = String(v); if (v === '') this.children = [] }
  get innerHTML() { return this._html ?? '' }
  set title(v) { this.attrs.title = v }
  get title() { return this.attrs.title ?? '' }
  appendChild(c) { this.children.push(c); return c }
  append(...cs) { for (const c of cs) this.children.push(c) }
  replaceChildren(...cs) { this.children = cs }
  remove() { this.isConnected = false }
  addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn) }
  removeEventListener() {}
  setAttribute(k, v) { this.attrs[k] = v }
  setPointerCapture() {}
  releasePointerCapture() {}
  querySelector() { return null }
  /** 收集文本（归一化空白，贴近真实 textContent 的读数） */
  allText() {
    const raw = (this._text + ' ' + this.children.map((c) => (c.allText ? c.allText() : c.textContent)).join(' ')).trim()
    return raw.replace(/\s+/g, ' ')
  }
}

const doc = {
  head: new El('head'),
  body: new El('body'),
  createElement: (t) => new El(t),
  createDocumentFragment: () => new El('fragment'),
  getElementById: () => null
}

globalThis.document = doc
globalThis.window = {
  innerWidth: 1600,
  innerHeight: 900,
  addEventListener() {},
  removeEventListener() {}
}
globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null },
  setItem(k, v) { this._m.set(k, String(v)) },
  removeItem(k) { this._m.delete(k) }
}

let captured = null
globalThis.window.__ModuleLoader__ = { load: (cfg) => { captured = cfg } }

/* ── 加载 bundle ───────────────────────────────────────────── */
const { readFileSync } = await import('node:fs')
const { fileURLToPath } = await import('node:url')
const bundlePath = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const src = readFileSync(bundlePath, 'utf8')
console.log('bundle: ' + (src.length / 1024 / 1024).toFixed(2) + 'MB')

const t0 = Date.now()
new Function(src)()
const parseMs = Date.now() - t0
console.log('✓ 解析并注册 factory，用时 ' + parseMs + 'ms')
if (!captured) throw new Error('没有调用 __ModuleLoader__.load')
console.log('  id = ' + captured.id)
const mod = captured.factory(() => { throw new Error('本插件不应 require 任何 external') })
const { apply, inject } = mod
console.log('  apply = ' + typeof apply + ' / inject = ' + JSON.stringify(inject))
if (typeof apply !== 'function') throw new Error('apply 不是函数')
if (!Array.isArray(inject)) throw new Error('inject 必须是数组（写成函数会让注入门控失效，三个数永远读 0）')
if (!inject.includes('sessions') || !inject.includes('uiSession')) throw new Error('inject 缺少必需服务')

/* ── 假 DSH 服务 ───────────────────────────────────────────── */
function snapshotStore(initial) {
  let value = initial
  const subs = new Set()
  return {
    getSnapshot: () => value,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn) },
    _set(v) { value = v; for (const f of subs) f() }
  }
}

const rows = {
  s1: { displayTitle: '会话一', origin: 'main', lastActivityAt: 300 },
  s2: { displayTitle: '会话二', origin: 'main', lastActivityAt: 200 },
  s3: { displayTitle: '会话三', origin: 'main', lastActivityAt: 100 },
  s4: { displayTitle: '会话四', origin: 'main', lastActivityAt: 90 },
  s5: { displayTitle: '会话五', origin: 'main', lastActivityAt: 80 },
  sub: { displayTitle: '子代理', origin: 'subagent', lastActivityAt: 400 },
  arch: { displayTitle: '归档的', origin: 'main', lastActivityAt: 500 },
  blank: { displayTitle: '空白', origin: 'main', blank: true, lastActivityAt: 600 }
}

const statusMap = new Map([
  ['s1', { running: true, pendingInteraction: undefined, completionUnread: false }],
  ['s2', { running: true, pendingInteraction: undefined, completionUnread: false }],
  ['s3', { running: true, pendingInteraction: undefined, completionUnread: false }],
  ['s4', { running: false, pendingInteraction: { kind: 'approval', sessionId: 's4' }, completionUnread: false }],
  ['s5', { running: false, pendingInteraction: undefined, completionUnread: true }],
  // 下面三个都必须被排除：子代理 / 已归档 / 不在会话列表里（已消失）
  ['sub', { running: true, pendingInteraction: undefined, completionUnread: false }],
  ['arch', { running: false, pendingInteraction: undefined, completionUnread: true }],
  ['gone', { running: true, pendingInteraction: undefined, completionUnread: false }]
])

const uiSession = { sessionStatus: snapshotStore(statusMap) }
const sessions = { list: snapshotStore({ phase: 'ready', ids: Object.keys(rows), byId: rows }) }
const workspaces = { list: snapshotStore({ items: [], archivedSessionIds: ['arch'] }) }
const opened = []
const uiWorkspace = { openSession: (id) => opened.push(id) }

const services = { uiSession, sessions, workspaces, uiWorkspace, settings: undefined }
const ctx = { get: (k) => services[k] }

/* ── 跑起来 ───────────────────────────────────────────────── */
const dispose = apply(ctx)
console.log('✓ apply() 未抛异常')

const root = doc.body.children.find((c) => c.id === 'dsh-session-hud')
if (!root) throw new Error('没有挂载 #dsh-session-hud')
const bubble = root.children.find((c) => c.className === 'hud-bubble')
const pet = root.children.find((c) => c.className === 'hud-pet')
const img = pet.children.find((c) => c.tagName === 'IMG')
const badge = pet.children.find((c) => c.className === 'hud-badge')

console.log('  宠物图 src 前缀 = ' + String(img.src).slice(0, 34) + '…')
if (!String(img.src).startsWith('data:image/webp;base64,')) throw new Error('宠物图没取到素材')

// 角标：有待选择时显示待选择数（2 = s4 approval + 没有别的），这里 pending 只有 s4 一个
console.log('  角标 = "' + badge.textContent + '" tone=' + badge.dataset.tone + ' empty=' + badge.dataset.empty)

// 展开气泡并断言三个数字
window.__dshSessionHud.show(true)
const text = bubble.allText()
console.log('  气泡文本: ' + text.replace(/\s+/g, ' '))
for (const [n, what] of [['3', '个在跑'], ['1', '个没看'], ['1', '个等你选']]) {
  if (!text.includes(n + ' ' + what)) throw new Error('气泡里没有「' + n + ' ' + what + '」')
}
console.log('✓ 三个数字正确（子代理/归档/空白/已消失的都被正确排除）')

/* ── 回归：主智能体空闲 + 子代理在跑 → 「进行中」绝不能报 0 ────────────────
 * 官方侧栏口径（asar 内 lib/.../Rows.js）：
 *   runningChildCount(list, parentId, statuses)
 *     = list.projectionsBySession[parentId].values.subagentCatalog
 *         里 statuses.get(child.id)?.running ?? list.byId[child.id]?.running 为真的个数
 *   sessionStatuses()：node.running === true 或 runningSubagentCount > 0 → state "ongoing"（转圈）
 * 也就是**父会话自己空闲，只有子代理在跑时，侧栏照样转圈**。
 * 旧代码只看主会话自身的 status.running（还把 origin==='subagent' 的行整个丢掉），
 * 于是同一时刻桌宠读 0 —— 这就是线上那个不一致。 */
const subRows = {
  p1: { displayTitle: '主会话（空闲，子代理在跑）', origin: 'main', lastActivityAt: 100 },
  p2: { displayTitle: '主会话（自己忙）', origin: 'main', lastActivityAt: 90 },
  c1: { displayTitle: '子代理一', origin: 'subagent', lastActivityAt: 200, running: true },
  c2: { displayTitle: '子代理二', origin: 'subagent', lastActivityAt: 190, running: true },
  c3: { displayTitle: '子代理三（已结束）', origin: 'subagent', lastActivityAt: 180, running: false }
}
const subStatus = new Map([
  ['p1', { running: false, pendingInteraction: undefined, completionUnread: false }],
  ['p2', { running: true, pendingInteraction: undefined, completionUnread: false }],
  ['c1', { running: true, pendingInteraction: undefined, completionUnread: false }],
  ['c2', { running: true, pendingInteraction: undefined, completionUnread: false }],
  ['c3', { running: false, pendingInteraction: undefined, completionUnread: false }]
])
sessions.list._set({
  phase: 'ready',
  ids: Object.keys(subRows),
  byId: subRows,
  projectionsBySession: {
    p1: { state: 'idle', error: null, values: { subagentCatalog: [{ id: 'c1' }, { id: 'c3' }] } },
    p2: { state: 'idle', error: null, values: { subagentCatalog: [{ id: 'c2' }] } }
  }
})
uiSession.sessionStatus._set(subStatus)
const subText = bubble.allText()
console.log('  子代理在跑时: ' + subText.replace(/\s+/g, ' '))
if (subText.includes('0 个在跑')) throw new Error('复现了原始 bug：主智能体空闲、子代理在跑，桌宠却报「0 个在跑」')
// p1 靠子代理 c1 算在跑，p2 自己 running；c2 是 p2 的 child（同一会话不重复计）
if (!subText.includes('2 个在跑')) throw new Error('「进行中」口径与侧栏不一致：期望 2 个会话在跑（p1 靠子代理 + p2 自己忙）')
console.log('✓ 主智能体空闲 + 子代理在跑时，「进行中」不为 0（与官方侧栏口径一致）')

// 信号源形状变化/缺失时不得抛异常，且退化回原行为（只数主会话自身 running）
let degradedThrew = false
try {
  sessions.list._set({
    phase: 'ready', ids: ['p1'], byId: { p1: subRows.p1 },
    projectionsBySession: { p1: { values: { subagentCatalog: '不是数组' } }, p2: null, p3: { values: null } }
  })
  sessions.list._set({ phase: 'ready', ids: ['p1'], byId: { p1: subRows.p1 } }) // 完全没有 projectionsBySession
} catch (err) {
  degradedThrew = true
  console.log('  退化用例抛了: ' + err.message)
}
if (degradedThrew) throw new Error('projectionsBySession 形状异常/缺失时不该抛异常')
if (!bubble.allText().includes('0 个在跑')) throw new Error('拿不到子代理信号时应退化为「只数自己的 running」= 0')
console.log('✓ projectionsBySession 缺失/形状异常时安全退化，不抛异常')

// 复原，后面的用例继续用原来的表
sessions.list._set({ phase: 'ready', ids: Object.keys(rows), byId: rows })
uiSession.sessionStatus._set(statusMap)

/* ── 「完成未读」口径钉死 ────────────────────────────────────────────────
 * v0.5.0 的调查结论：这一条**不是 bug**（曾经怀疑 completionUnread 对主会话恒为 false）。
 * asar 里查清了 isMain 的真实含义：
 *   471629  isMain(id) = (byId[id].retainedBy.mainView ?? 0) > 0
 *   718647  source:"mainView" 只在 uiWorkspace.openSession 里 retain
 *           → 即「你当前打开的那**一个**会话」，不是「origin === 'main'」
 *   471603-471609  observeRunning：running → false 且 !isMain → completionUnread.add
 *   471620  reconcileStatus 只对 isMain 的会话 clear
 *   721643  侧栏字典 "status.completed":"已完成"；718135/719101 用它驱动那个状态
 * 所以：**不在主视图里的其它会话（含普通主会话）跑完照样标 unread**，
 *       只有你正开着的那一个不标（你已经在看了）。这条语义在这里钉住。 */
{
  const bgRow = { displayTitle: '后台跑完的会话', origin: 'main', lastActivityAt: 10 }
  const curRow = { displayTitle: '你正开着的会话', origin: 'main', lastActivityAt: 20 }
  sessions.list._set({ phase: 'ready', ids: ['cur', 'bg'], byId: { cur: curRow, bg: bgRow } })
  uiSession.sessionStatus._set(new Map([
    ['cur', { running: false, pendingInteraction: undefined, completionUnread: false }], // 主视图会话不标
    ['bg', { running: false, pendingInteraction: undefined, completionUnread: true }] // 后台跑完 → 标
  ]))
  const ct = bubble.allText()
  if (!ct.includes('1 个没看')) throw new Error('「完成未读」没有数到「跑完但你没打开」的会话')
  if (ct.includes('2 个没看')) throw new Error('「完成未读」把主视图会话也算进去了')
  console.log('✓ 「完成未读」口径正确：非主视图会话跑完计数，主视图会话不计数（isMain 语义已钉死）')
}

/* ── 规则②钉住：**子代理跑完不算「完成未读」** ────────────────────────────
 * 用户裁决：「只有**主代理跑完了但我没点开**才会标明没看」。
 * 注意这条**在旧代码上也通过**（旧代码同样不看子代理的 completionUnread）——
 * 它是防未来的回归网：哪天有人顺手把子代理的 unread 也聚合进来，这里会失败。 */
{
  const parentRow = { displayTitle: '主会话', origin: 'main', lastActivityAt: 10 }
  const childRow = { displayTitle: '子代理', origin: 'subagent', lastActivityAt: 20 }
  const base = {
    phase: 'ready',
    ids: ['mA', 'c1'],
    byId: { mA: parentRow, c1: childRow },
    projectionsBySession: { mA: { values: { subagentCatalog: [{ id: 'c1' }] } } }
  }
  // (a) 子代理跑完（子自己有 completionUnread，主会话没有）→ 完成未读必须是 0
  sessions.list._set(base)
  uiSession.sessionStatus._set(new Map([
    ['mA', { running: false, pendingInteraction: undefined, completionUnread: false }],
    ['c1', { running: false, pendingInteraction: undefined, completionUnread: true }]
  ]))
  const a = bubble.allText()
  if (!a.includes('0 个没看')) throw new Error('规则②破了：子代理跑完被算进了「完成未读」 → ' + a)
  console.log('✓ 规则②：子代理跑完 **不** 计入「完成未读」')
  // (b) 同一个 world，把 unread 挪到主会话身上 → 必须变成 1（对照组，证明这条数没坏）
  uiSession.sessionStatus._set(new Map([
    ['mA', { running: false, pendingInteraction: undefined, completionUnread: true }],
    ['c1', { running: false, pendingInteraction: undefined, completionUnread: false }]
  ]))
  const b = bubble.allText()
  if (!b.includes('1 个没看')) throw new Error('规则②对照组破了：主会话跑完却没计入「完成未读」 → ' + b)
  console.log('✓ 规则②对照组：同一 world 下主会话跑完 → 「完成未读」= 1')
}

/* ── 组合矩阵：多状态共存时三个计数各自独立正确、互不吞掉 ────────────────
 * 维度：R = 会话自身 running · S = 有 running 的直接子代理 · C = completionUnread
 *       P = pendingInteraction · Q = 排队输入（inbox 投影，**官方侧栏无此状态**）
 *
 * 官方侧栏的状态词表（asar 721633-721643 zh，全部状态就这些）：
 *   status.running 进行中 | status.subagentsRunning 子智能体运行中 | status.idle 空闲
 *   status.waitingApproval 等待审批 | status.planReview 计划待审 |
 *   status.waitingAnswer 等待回答 | status.completed 已完成
 *   —— 里面**没有**排队/插话之类；QueueDock 的 "queue.count" 属于对话区（418359），不是会话状态。
 *
 * 桌宠的气泡是三行**独立**计数（不是 if/else 链），所以多状态共存时不能丢信息；
 * 唯一的 if/else 链是角标（只有一位数字），优先级 fixed：待选择 > 进行中 > 完成未读，
 * 与侧栏 statuses[0] 的顺序一致（719092-719108）。角标 tooltip 里始终带着三个数。 */

const mainRow = (over = {}) => ({ displayTitle: '主会话', origin: 'main', lastActivityAt: 100, ...over })
const subRow = (over = {}) => ({ displayTitle: '子代理', origin: 'subagent', lastActivityAt: 50, ...over })
const mst = (over = {}) => ({ running: false, pendingInteraction: undefined, completionUnread: false, ...over })
const cat = (...ids) => ({ state: 'idle', error: null, values: { subagentCatalog: ids.map((id) => ({ id })) } })

function setWorld({ rows: r, status, projectionsBySession }) {
  sessions.list._set({
    phase: 'ready',
    ids: Object.keys(r),
    byId: r,
    ...(projectionsBySession === undefined ? {} : { projectionsBySession })
  })
  uiSession.sessionStatus._set(new Map(status))
}

// 先采出四种情绪各自的素材 src，用来反查 pickEmotion 的选择结果（不暴露内部字段）
const emotionSrc = {}
for (const [name, world] of [
  ['dozing', { rows: { mA: mainRow() }, status: [['mA', mst()]] }],
  ['busy', { rows: { mA: mainRow() }, status: [['mA', mst({ running: true })]] }],
  ['waiting', { rows: { mA: mainRow() }, status: [['mA', mst({ pendingInteraction: { kind: 'question' } })]] }],
  ['celebrate', { rows: { mA: mainRow() }, status: [['mA', mst({ completionUnread: true })]] }]
]) {
  setWorld(world)
  emotionSrc[name] = String(img.src)
}
if (new Set(Object.values(emotionSrc)).size !== 4) throw new Error('四种情绪没有映射到四张不同素材，情绪断言不可靠')

const MATRIX = [
  // id               世界                                                                             期望 {在跑, 没看, 待选}  情绪        角标
  { id: 'R', world: { rows: { mA: mainRow() }, status: [['mA', mst({ running: true })]] }, want: [1, 0, 0], emo: 'busy', badge: ['1', 'run'] },
  { id: 'S', world: { rows: { mA: mainRow(), c1: subRow() }, status: [['mA', mst()], ['c1', mst({ running: true })]], projectionsBySession: { mA: cat('c1') } }, want: [1, 0, 0], emo: 'busy', badge: ['1', 'run'] },
  { id: 'R+S', world: { rows: { mA: mainRow(), c1: subRow() }, status: [['mA', mst({ running: true })], ['c1', mst({ running: true })]], projectionsBySession: { mA: cat('c1') } }, want: [1, 0, 0], emo: 'busy', badge: ['1', 'run'] },
  { id: 'C', world: { rows: { mA: mainRow() }, status: [['mA', mst({ completionUnread: true })]] }, want: [0, 1, 0], emo: 'celebrate', badge: ['1', 'done'] },
  { id: 'P:approval', world: { rows: { mA: mainRow() }, status: [['mA', mst({ pendingInteraction: { kind: 'approval' } })]] }, want: [0, 0, 1], emo: 'waiting', badge: ['1', 'wait'] },
  { id: 'R+P:question', world: { rows: { mA: mainRow() }, status: [['mA', mst({ running: true, pendingInteraction: { kind: 'question' } })]] }, want: [1, 0, 1], emo: 'waiting', badge: ['1', 'wait'] },
  { id: 'S+P:plan-review', world: { rows: { mA: mainRow(), c1: subRow() }, status: [['mA', mst({ pendingInteraction: { kind: 'plan-review' } })], ['c1', mst({ running: true })]], projectionsBySession: { mA: cat('c1') } }, want: [1, 0, 1], emo: 'waiting', badge: ['1', 'wait'] },
  { id: 'S+C', world: { rows: { mA: mainRow(), c1: subRow() }, status: [['mA', mst({ completionUnread: true })], ['c1', mst({ running: true })]], projectionsBySession: { mA: cat('c1') } }, want: [1, 1, 0], emo: 'busy', badge: ['1', 'run'] },
  { id: 'P+C', world: { rows: { mA: mainRow() }, status: [['mA', mst({ completionUnread: true, pendingInteraction: { kind: 'approval' } })]] }, want: [0, 1, 1], emo: 'waiting', badge: ['1', 'wait'] },
  { id: 'R+P+C(官方不可能)', world: { rows: { mA: mainRow() }, status: [['mA', mst({ running: true, completionUnread: true, pendingInteraction: { kind: 'approval' } })]] }, want: [1, 1, 1], emo: 'waiting', badge: ['1', 'wait'] },
  {
    id: 'P:unknown-kind',
    world: { rows: { mA: mainRow() }, status: [['mA', mst({ pendingInteraction: { kind: '未来的新种类' } })]] },
    want: [0, 0, 1], emo: 'waiting', badge: ['1', 'wait']
  },
  { id: 'P:null(防御)', world: { rows: { mA: mainRow() }, status: [['mA', mst({ pendingInteraction: null })]] }, want: [0, 0, 0], emo: 'dozing', badge: ['0', 'run'] },
  {
    // 孙辈在跑：官方 runningChildCount 只看**直接**子级（718124 不递归）。孙辈算在它自己的父会话 c1 头上，
    // 而 c1 不是侧栏的行 → mA 在侧栏也是空闲。桌宠必须同样报 0。
    id: '孙辈在跑(只数直接子级)',
    world: {
      rows: { mA: mainRow(), c1: subRow(), g1: subRow() },
      status: [['mA', mst()], ['c1', mst()], ['g1', mst({ running: true })]],
      projectionsBySession: { mA: cat('c1'), c1: cat('g1') }
    },
    want: [0, 0, 0], emo: 'dozing', badge: ['0', 'run']
  },
  /* ── 规则③（v0.6.0，用户裁决）：子代理的待交互也算「等我选」 ──────────────
   * 侧栏**不**这么算（718128 只看会话自己的 pendingInteraction）—— 有意分叉。
   * 这三行在 v0.5.0/v0.3.0 的代码上会失败：旧代码用 `if (!rows[id]) continue` 把子代理整行滤掉。 */
  {
    id: 'S+P(child 持有)',
    world: {
      rows: { mA: mainRow(), c1: subRow() },
      status: [['mA', mst()], ['c1', mst({ running: true, pendingInteraction: { kind: 'question' } })]],
      projectionsBySession: { mA: cat('c1') }
    },
    want: [1, 0, 1], emo: 'waiting', badge: ['1', 'wait'], kinds: { question: 1 }
  },
  {
    id: 'P(main)+P(child)',
    world: {
      rows: { mA: mainRow(), c1: subRow() },
      status: [['mA', mst({ pendingInteraction: { kind: 'approval' } })], ['c1', mst({ running: true, pendingInteraction: { kind: 'question' } })]],
      projectionsBySession: { mA: cat('c1') }
    },
    want: [1, 0, 2], emo: 'waiting', badge: ['2', 'wait'], kinds: { approval: 1, question: 1 }
  },
  {
    // 只数直接子级：孙辈的 pending 不算到祖父头上（与 runningChildCount 的层级口径一致）
    id: '孙辈 pending(只数直接子级)',
    world: {
      rows: { mA: mainRow(), c1: subRow(), g1: subRow() },
      status: [['mA', mst()], ['c1', mst()], ['g1', mst({ running: true, pendingInteraction: { kind: 'question' } })]],
      projectionsBySession: { mA: cat('c1'), c1: cat('g1') }
    },
    want: [0, 0, 0], emo: 'dozing', badge: ['0', 'run']
  },
  {
    // 规则②：子代理跑完不算「完成未读」（矩阵里也钉一遍）
    id: 'C(child 持有, 规则②)',
    world: {
      rows: { mA: mainRow(), c1: subRow() },
      status: [['mA', mst()], ['c1', mst({ completionUnread: true })]],
      projectionsBySession: { mA: cat('c1') }
    },
    want: [0, 0, 0], emo: 'dozing', badge: ['0', 'run']
  },
  {
    id: 'Q:排队输入(官方无此状态)',
    world: {
      rows: { mA: mainRow({ projectionValues: { inbox: { 'next-turn': [{ itemId: 'q1', text: '运行中又发的一条' }] } } }) },
      status: [['mA', mst({ running: true })]]
    },
    want: [1, 0, 0], emo: 'busy', badge: ['1', 'run']
  },
  {
    // 多会话混合：2 个在跑（1 自己忙 + 1 靠子代理）、1 个没看、2 个等你选 —— 一个都不能丢
    id: '混合 5 会话',
    world: {
      rows: { m1: mainRow(), m2: mainRow(), m3: mainRow(), m4: mainRow(), m5: mainRow(), c1: subRow() },
      status: [
        ['m1', mst({ running: true })],
        ['m2', mst()],
        ['m3', mst({ completionUnread: true })],
        ['m4', mst({ pendingInteraction: { kind: 'approval' } })],
        ['m5', mst({ running: true, pendingInteraction: { kind: 'question' } })],
        ['c1', mst({ running: true })]
      ],
      projectionsBySession: { m2: cat('c1') }
    },
    want: [3, 1, 2], emo: 'waiting', badge: ['2', 'wait']
  },
  {
    // 形状防御：某条状态为 null（官方不会，但形状一变不许抛，也不许把它算进去）
    id: '状态条目为 null(防御)',
    world: { rows: { mA: mainRow(), mB: mainRow() }, status: [['mA', mst({ running: true })], ['mB', null]] },
    want: [1, 0, 0], emo: 'busy', badge: ['1', 'run']
  },
  {
    // 角标封顶：12 个子代理都在等你 → 角标显示 9+（不是 "12"），但气泡里的数字仍然精确
    id: 'P×12(child, 角标封顶)',
    world: (() => {
      const rowsW = { mA: mainRow() }
      const statusW = [['mA', mst()]]
      const kids = []
      for (let i = 1; i <= 12; i += 1) {
        const cid = 'c' + i
        kids.push(cid)
        rowsW[cid] = subRow()
        statusW.push([cid, mst({ running: true, pendingInteraction: { kind: 'question' } })])
      }
      return { rows: rowsW, status: statusW, projectionsBySession: { mA: cat(...kids) } }
    })(),
    want: [1, 0, 12], emo: 'waiting', badge: ['9+', 'wait']
  }
]

console.log('')
console.log('  组合矩阵（在跑 / 没看 / 待选 · 情绪 · 角标）:')
const failures = []
for (const sc of MATRIX) {
  setWorld(sc.world)
  const c = window.__dshSessionHud.state.counts
  const txt = bubble.allText()
  const [r, u, p] = sc.want
  const emoNow = Object.keys(emotionSrc).find((k) => emotionSrc[k] === String(img.src)) ?? '(未知素材)'
  const problems = []

  if (c.running !== r || c.unread !== u || c.pending !== p) {
    problems.push('计数期望 ' + r + '/' + u + '/' + p + '，实际 ' + c.running + '/' + c.unread + '/' + c.pending)
  }
  // 三行必须都在（多状态共存时不能互相吞掉）
  for (const w of [r + ' 个在跑', u + ' 个没看', p + ' 个等你选']) {
    if (!txt.includes(w)) problems.push('气泡里缺「' + w + '」（状态被吞了）')
  }
  if (String(img.src) !== emotionSrc[sc.emo]) problems.push('情绪期望 ' + sc.emo + '，实际 ' + emoNow)
  if (sc.kinds !== undefined) {
    const got = window.__dshSessionHud.state.byKind
    if (JSON.stringify(got) !== JSON.stringify(sc.kinds)) {
      problems.push('byKind 期望 ' + JSON.stringify(sc.kinds) + '，实际 ' + JSON.stringify(got))
    }
  }
  if (badge.textContent !== sc.badge[0] || badge.dataset.tone !== sc.badge[1]) {
    problems.push('角标期望 ' + sc.badge.join('/') + '，实际 ' + badge.textContent + '/' + badge.dataset.tone)
  }
  // 角标只有一位数字，但 tooltip 必须始终带三个数（信息不能在角标里被吃掉）
  const tip = badge.title ?? ''
  for (const w of ['待选择 ' + p, '进行中 ' + r, '完成未读 ' + u]) {
    if (!tip.includes(w)) problems.push('角标 tooltip 缺「' + w + '」')
  }

  console.log('    ' + sc.id.padEnd(26) + '→ ' + c.running + ' / ' + c.unread + ' / ' + c.pending +
    ' · ' + emoNow + ' · 角标 ' + badge.textContent + '(' + badge.dataset.tone + ')' +
    (problems.length === 0 ? '' : '   ✗ ' + problems.join('; ')))
  // 收集全部失败再报：一次就能看出是哪几个组合挂了，而不是只看第一个
  if (problems.length > 0) failures.push(sc.id + ' → ' + problems.join('; '))
}
if (failures.length > 0) {
  throw new Error('组合矩阵有 ' + failures.length + ' / ' + MATRIX.length + ' 个组合不通过:\n      ' + failures.join('\n      '))
}
console.log('  ↑ 每个组合的三个计数都独立正确、三行都在、情绪与侧栏 statuses[0] 同序、角标 tooltip 带全三个数')
console.log('✓ 组合矩阵全部通过（' + MATRIX.length + ' 个组合，无状态被 if/else 吞掉）')

/* ── 规则③专项：跳转目标 / 去重 / 退化 ────────────────────────────────────
 * 这三件事矩阵表断言不到，单独钉。 */
{
  const parentRow = mainRow({ displayTitle: '父会话' })
  const childRow = subRow({ displayTitle: '在问你的子代理' })
  const withChildPending = {
    phase: 'ready',
    ids: ['mA', 'c1'],
    byId: { mA: parentRow, c1: childRow },
    projectionsBySession: { mA: cat('c1') }
  }
  sessions.list._set(withChildPending)
  uiSession.sessionStatus._set(new Map([
    ['mA', { running: true, pendingInteraction: undefined, completionUnread: false }],
    ['c1', { running: true, pendingInteraction: { kind: 'approval' } }]
  ]))

  // (1) 条目必须挂在**子会话**上：点「个等你选」要跳到真正挂着交互面板的那个会话
  const pend = window.__dshSessionHud.state.pending
  if (pend.length !== 1) throw new Error('规则③：子代理 pending 没被算进来，pending=' + pend.length)
  if (pend[0].id !== 'c1') throw new Error('规则③：待选条目挂在 ' + pend[0].id + '，应该挂在子会话 c1')
  if (pend[0].row?.displayTitle !== '在问你的子代理') throw new Error('规则③：跳转提示标题取不到子会话标题')
  if (pend[0].kind !== 'approval') throw new Error('规则③：kind 取错了 → ' + pend[0].kind)
  console.log('✓ 规则③：待选条目挂在子会话 id 上（点数字会跳到挂着交互面板的那个会话）')

  // (2) 去重：同一个 id 在父目录里出现两次（形状异常）也只算一次
  sessions.list._set({
    ...withChildPending,
    projectionsBySession: { mA: { values: { subagentCatalog: [{ id: 'c1' }, { id: 'c1' }, { id: 'c1' }] } } }
  })
  if (window.__dshSessionHud.state.counts.pending !== 1) {
    throw new Error('规则③：重复目录项导致重复计数 → ' + window.__dshSessionHud.state.counts.pending)
  }
  // 两道口子：Set 去重 + publishPendingInteractions 每 sessionId 只有一个 pending
  console.log('✓ 规则③：同一会话的 pending 无论被走到几次都只算 1（Set 去重）')

  // (3) 退化：拿不到投影时不许抛、不许显示错，退回「只数主会话」= 0
  sessions.list._set({ phase: 'ready', ids: ['mA'], byId: { mA: parentRow } })
  const afterNoProj = window.__dshSessionHud.state.counts
  if (afterNoProj.pending !== 0 || afterNoProj.running !== 1) {
    throw new Error('规则③退化：拿不到 projectionsBySession 时应退回只数主会话 → ' + JSON.stringify(afterNoProj))
  }
  // (4) 退化：sessionStatus 整个不可用 → 三个数都不抛、pending 归 0（原行为）
  uiSession.sessionStatus._set(new Map())
  const emptyStatus = window.__dshSessionHud.state.counts
  if (emptyStatus.pending !== 0) throw new Error('规则③退化：status 为空时不该凭空报 pending')
  console.log('✓ 规则③退化：拿不到子代理 pending（无投影 / status 为空）时安全退化为原行为，不抛异常')
}

// 复原，后面的用例继续用原来的表
sessions.list._set({ phase: 'ready', ids: Object.keys(rows), byId: rows })
uiSession.sessionStatus._set(statusMap)

// 全 0 时也必须把 0 显示出来（v0.1.0 的 bug：0 被藏了，只剩「个在跑」）
const allZero = new Map([['s1', { running: false, pendingInteraction: undefined, completionUnread: false }]])
uiSession.sessionStatus._set(allZero)
const ztext = bubble.allText()
console.log('  全 0 时: ' + ztext.replace(/\s+/g, ' '))
for (const w of ['0 个在跑', '0 个没看', '0 个等你选']) {
  if (!ztext.includes(w)) throw new Error('全 0 时没有显示「' + w + '」')
}
console.log('✓ 全 0 时数字照常显示')
uiSession.sessionStatus._set(statusMap)

// 跳转
window.__dshSessionHud.open('s2')
if (opened[0] !== 's2') throw new Error('openSession 没被调用')
console.log('✓ 跳转可用: openSession("s2") 已调用')

// 三分类细分
const st = window.__dshSessionHud.state
console.log('  细分: byKind=' + JSON.stringify(st.byKind) + ' counts=' + JSON.stringify(st.counts))

// 扩展接口
const off = window.__dshSessionHud.registerBubbleSource({
  id: 'test-schedule', order: 100,
  getLines: () => [{ icon: '📅', text: '14:00 组会' }]
})
window.__dshSessionHud.refresh()
const t2 = bubble.allText()
if (!t2.includes('14:00 组会')) throw new Error('扩展气泡源没渲染出来')
console.log('✓ registerBubbleSource 扩展接口可用')
off()
window.__dshSessionHud.refresh()
if (bubble.allText().includes('14:00 组会')) throw new Error('注销扩展源失败')
console.log('✓ 扩展源注销可用')

// 订阅驱动
statusMap.set('s1', { running: false, pendingInteraction: undefined, completionUnread: true })
uiSession.sessionStatus._set(statusMap)
const t3 = bubble.allText()
console.log('  状态变化后: ' + t3.replace(/\s+/g, ' '))
if (!t3.includes('2 个在跑')) throw new Error('订阅没有驱动重渲染')

// 清理
window.__dshSessionHud.unmount()
console.log('✓ unmount 可用')
console.log('')
console.log('全部通过 ✅')