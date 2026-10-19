/**
 * dsh-session-hud · client half 的行为主体
 *
 * 本文件由 tools/build.mjs 拼进 window.__ModuleLoader__.load({...}) 的 factory 里，
 * 前缀是生成的宠物素材表（PET_ASSETS / PET_EMOTIONS / PET_SKINS）。
 * 因此这里**不能**出现 import / export 语句，只能用 factory 里的 `require`。
 *
 * 数据来源全部是 DSH 原生客户端服务，事件驱动、零轮询：
 *   ctx.get("uiSession").sessionStatus  → Map<sessionId, {running, pendingInteraction, completionUnread}>
 *   ctx.get("sessions").list            → { ids, byId: { [id]: row }, projectionsBySession }
 *   ctx.get("workspaces").list          → { items, archivedSessionIds }
 *   ctx.get("uiWorkspace").openSession  → 跳转到会话
 *
 * 三个数字的判定（**用户 2026-10-16 裁决的语义**，见 README §1.1）：
 *   「进行中」   = 主会话自己 running，**或**它名下有 running 的直接子代理
 *   「完成未读」 = **只**看主会话自己的 completionUnread（子代理跑完不算）
 *   「待你选择」 = 主会话自己的 pendingInteraction，**或**它名下直接子代理的 pendingInteraction
 * 三个数字都仍然是「一个数字 = 一个会话」，只是判定聚合了直接子级。
 *
 * ① 「进行中」与官方侧栏**同口径**（官方 lib/.../Rows.js）：
 *   runningChildCount(list, parentId, statuses)
 *     = list.projectionsBySession[parentId].values.subagentCatalog 里
 *       (statuses.get(child.id)?.running ?? list.byId[child.id]?.running) === true 的个数
 *   sessionStatuses(): node.running === true 或 runningSubagentCount > 0 → ongoing（转圈）
 * 主智能体空闲、只有子代理在跑时，侧栏照样转圈；只读主会话自己的 status.running
 * 会读到 0，两者就不一致了（v0.3.0 的 bug）。
 *
 * ② 「完成未读」= uiSession 的 completionUnread，**只对「不在主视图里」的会话置位**
 * （v0.5.0 查清，见 readState 里的注释）。它不是恒 false 的死信号，别再来怀疑一次：
 *   侧栏 718135 `completed: status?.completionUnread === true` → 719101 显示
 *   "已完成"（字典 721643 `"status.completed": "已完成"`）。
 *
 * ③ 「待你选择」**有意与官方侧栏分叉**：侧栏只看会话自己的 pendingInteraction
 * （718128 `visiblePendingKind(status?.pendingInteraction?.kind)`），**不聚合子代理的**。
 * 这里按用户裁决把直接子代理的 pending 也算进来 —— 子代理的 pending 本来就登记在
 * **子会话 id** 名下、躺在同一张 sessionStatus Map 里（取证见 readState 里的注释），
 * 所以不需要新服务、不需要新订阅。分叉是明示的，不是失手。
 */

const HUD_ID = 'dsh-session-hud'
const HUD_STYLE_ID = 'dsh-session-hud-style'
const HUD_LS_KEY = 'dsh-session-hud:prefs'
const HUD_VERSION = '0.6.0'
/** 宠物盒子边长；buildStyle() 里的 CSS 直接引用它，改这一处即可。 */
const HUD_SIZE = 141

/** 待交互种类的展示文案（与 dsh-activity-pane 的口径一致）。 */
const PENDING_LABELS = {
  approval: '待确认授权',
  'plan-review': '待审查计划',
  question: '待回答问题'
}
const PENDING_SHORT = {
  approval: '确认',
  'plan-review': '审查',
  question: '提问'
}
const PENDING_UNKNOWN = '待处理'

/** 素材来自 dsh-pet（MIT），键名与 convert-pet.py 里的 PICKS 一致。 */
const EMOTIONS = ['dozing', 'busy', 'waiting', 'celebrate', 'drag']

function hudLog(...args) {
  try {
    if (localStorage.getItem('dsh-session-hud:debug') === '1') console.log('[' + HUD_ID + ']', ...args)
  } catch {
    /* localStorage 不可用时不日志 */
  }
}

function readPrefs() {
  try {
    const raw = localStorage.getItem(HUD_LS_KEY)
    if (raw) return JSON.parse(raw)
  } catch {
    /* 忽略损坏的偏好 */
  }
  return {}
}

function writePrefs(patch) {
  try {
    const next = { ...readPrefs(), ...patch }
    localStorage.setItem(HUD_LS_KEY, JSON.stringify(next))
    return next
  } catch {
    return readPrefs()
  }
}

function clampToViewport(x, y, w, h) {
  const maxX = Math.max(0, window.innerWidth - w)
  const maxY = Math.max(0, window.innerHeight - h)
  return { x: Math.min(Math.max(0, x), maxX), y: Math.min(Math.max(0, y), maxY) }
}

/* ────────────────────────── 气泡内容提供者接口 ──────────────────────────
 * 这是留给后续功能的扩展点。默认只注册一个「三数字」提供者；
 * 以后要加「个人日程播报」之类，只要在别的插件里注册一个新 source：
 *
 *   window.__dshSessionHud.registerBubbleSource({
 *     id: 'schedule',
 *     order: 100,                       // 数字越小越靠上；默认 50
 *     getLines: (state) => [{ icon: '📅', text: '14:00 组会', tone: 'info' }]
 *   })
 *
 * getLines 每帧渲染时调用，返回的行会追加在默认三行之后。
 * 返回的行可带 onClick(state)，留空则不可点。
 * ─────────────────────────────────────────────────────────────────────── */

const bubbleSources = new Map()

function registerBubbleSource(source) {
  if (!source || typeof source.id !== 'string' || typeof source.getLines !== 'function') {
    throw new Error('registerBubbleSource 需要 { id: string, getLines(state) }')
  }
  bubbleSources.set(source.id, source)
  refreshAll()
  return () => {
    bubbleSources.delete(source.id)
    refreshAll()
  }
}

/** 所有已注册实例（一般只有一个；多实例时同步渲染）。 */
const instances = new Set()
function refreshAll() {
  for (const inst of instances) {
    try {
      inst.render()
    } catch (err) {
      hudLog('render failed', err)
    }
  }
}

/* ────────────────────────────── 状态读取 ────────────────────────────── */

/**
 * 该会话名下**还在跑的直接子代理**个数 —— 官方侧栏 `runningChildCount` 的同义实现。
 *
 * 官方表达式（D:\...\app.asar 内 lib/.../Rows.js）：
 *   list.projectionsBySession[parentId]?.values.subagentCatalog
 *     ?.reduce((n, child) => n + ((statuses.get(child.id)?.running ?? list.byId[child.id]?.running) === true ? 1 : 0), 0) ?? 0
 * 差别只在：这里全程 try/catch + 类型检查。客户端快照是活对象，字段形状随版本变，
 * 而且本函数在渲染路径上被调用 —— 抛异常会打断整次 render，宁可返回 0（退化回原行为）。
 *
 * 只数**直接**子级，与侧栏一致（孙辈要算到它自己的父会话上，而那个父会话不是侧栏的行）。
 *
 * @param list     sessions.list 快照；缺 projectionsBySession 时返回 0
 * @param parentId 主会话 id
 * @param statuses uiSession.sessionStatus 快照（Map），可为 undefined
 */
function runningChildCount(list, parentId, statuses) {
  try {
    const catalog = subagentCatalog(list, parentId)
    const byId = list?.byId
    let count = 0
    for (const child of catalog) {
      const childId = child?.id
      if (typeof childId !== 'string' || childId === '') continue
      // 与官方同序：优先统一状态，缺失才回落到会话摘要
      const childRunning = statuses && typeof statuses.get === 'function'
        ? (statuses.get(childId)?.running ?? byId?.[childId]?.running)
        : byId?.[childId]?.running
      if (childRunning === true) count += 1
    }
    return count
  } catch (err) {
    hudLog('runningChildCount failed', parentId, err)
    return 0
  }
}

/**
 * 取某个会话的**直接**子代理目录。形状认不出来就返回空数组（调用方据此退化，不抛）。
 * 官方出处：`projectionsBySession[parentId].values.subagentCatalog`（asar 336696 / 336743）。
 */
function subagentCatalog(list, parentId) {
  try {
    const catalog = list?.projectionsBySession?.[parentId]?.values?.subagentCatalog
    return Array.isArray(catalog) ? catalog : []
  } catch (err) {
    hudLog('subagentCatalog failed', parentId, err)
    return []
  }
}

/**
 * 某个 sessionId 的待交互种类；没有 pending 返回 null。
 * pending 就登记在这个 id 名下（含子代理会话，见文件头的取证），形状不对一律当没有。
 */
function pendingKindOf(statuses, id) {
  try {
    if (!statuses || typeof statuses.get !== 'function') return null
    const pi = statuses.get(id)?.pendingInteraction
    if (pi === undefined || pi === null) return null
    return typeof pi.kind === 'string' ? pi.kind : 'unknown'
  } catch (err) {
    hudLog('pendingKindOf failed', id, err)
    return null
  }
}

/**
 * 从 DSH 原生服务算出三个数字。
 * 口径：只统计主会话（排除子代理、归档、空白会话）—— 即"每个数字=一个会话"。
 * 但判定是**聚合**口径（用户 2026-10-16 裁决）：
 *   进行中   = 会话自己 running，或它名下有 running 的直接子代理
 *   完成未读 = **只**看主会话自己的 completionUnread（子代理跑完不算）
 *   待选择   = 会话自己的 pendingInteraction，或它名下直接子代理的 pendingInteraction
 */
function readState(ctx) {
  const empty = { running: [], unread: [], pending: [], byKind: {}, counts: { running: 0, unread: 0, pending: 0 } }
  let ui, sessions, workspaces
  try {
    ui = ctx.get('uiSession')
    sessions = ctx.get('sessions')
    workspaces = ctx.get('workspaces')
  } catch (err) {
    hudLog('service lookup failed', err)
    return empty
  }

  const list = sessions?.list?.getSnapshot?.()
  if (!list || !list.byId) return empty
  const status = ui?.sessionStatus?.getSnapshot?.()

  const archived = new Set(workspaces?.list?.getSnapshot?.()?.archivedSessionIds ?? [])
  const rows = {}

  for (const id of Object.keys(list.byId)) {
    const row = list.byId[id]
    if (!row) continue
    if (row.origin === 'subagent') continue // 子代理不单独占一行；它的活跃度算在父会话头上（见 runningChildCount）
    if (row.blank) continue // 空白会话不计入
    if (archived.has(id)) continue
    rows[id] = row
  }

  const running = []
  const unread = []
  const pending = []
  const byKind = {}
  const at = (row) => row?.lastActivityAt ?? row?.updatedAt ?? row?.createdAt ?? 0

  if (status && typeof status.forEach === 'function') {
    for (const [id, st] of status) {
      if (!rows[id] || !st) continue
      // 主会话自己 running，或它名下还有子代理在跑 → 这个会话算「进行中」。
      // 子代理行本身在 rows 里被剔除（origin === 'subagent'），所以不会重复计数。
      if (st.running === true || runningChildCount(list, id, status) > 0) running.push({ id, row: rows[id] })
      // completionUnread 是 uiSession 自己的信号，直接用，不做二次推导。
      // 它的语义（v0.5.0 从 asar 查清，之前误以为是死信号）：
      //   471629  isMain(id) = (byId[id].retainedBy.mainView ?? 0) > 0
      //   718647  只有 uiWorkspace.openSession 会 retain(source:"mainView")
      //           → isMain 指「你当前打开的那一个会话」，而不是「origin === 'main'」
      //   471603  observeRunning：running → false 且 !isMain → completionUnread.add(id)
      //   471620  reconcileStatus 只对 isMain 的会话 clear
      // 即：不在主视图里的会话（含普通主会话）跑完会置位；你正开着的那个不置位。
      if (st.completionUnread === true) unread.push({ id, row: rows[id] })
    }
    /* 「待你选择」= 主会话自身的 pending + 它**直接**子代理的 pending。
     * ⚠️ 这一条**有意与官方侧栏分叉**：侧栏只认会话自己的 pendingInteraction
     * （718128 `visiblePendingKind(status?.pendingInteraction?.kind)`），
     * 它没有把子代理的 pending 聚合上去。依据是用户 2026-10-16 的明确要求
     * （"无论主代理或者子代理需要我交互…就算做等我选"），见 README §1.1。
     *
     * 子代理的 pending 和主会话的在**同一张** sessionStatus Map 里，key 是子会话 id
     * （asar 336653 每个会话一个 scope、tag=sessionId；386458 / 715845
     *  `ctx.sessions.scopeOf(owner)` → 登记在请求方会话名下；471591-471596 按
     * `interaction.sessionId` 归档；471631-471643 汇进同一张 Map）。
     * 所以不需要新服务、不需要新订阅 —— 只要别再被 rows 白名单挡住。
     *
     * 去重是结构性的：publishPendingInteractions 每个 sessionId 只保留一个 pending，
     * 所以「一个 sessionId 最多贡献 1」。这里再压一层 seen 集合，
     * 即使目录形状异常导致同一个 id 被走到两次也只算一次。
     * 另外子代理的条目挂**子会话自己的 id/row**，这样点数字会直接跳到
     * 那个真正挂着交互面板的会话，而不是父会话。 */
    const seen = new Set()
    const take = (id, row) => {
      if (id === undefined || id === null || seen.has(id)) return
      const kind = pendingKindOf(status, id)
      if (kind === null) return
      seen.add(id)
      pending.push({ id, row, kind })
      byKind[kind] = (byKind[kind] ?? 0) + 1
    }
    for (const id of Object.keys(rows)) {
      take(id, rows[id]) // 主会话自己的
      for (const child of subagentCatalog(list, id)) {
        const childId = child?.id
        if (typeof childId !== 'string' || childId === '') continue
        // 子代理行不在 rows 里，单独从 byId 取；再兜底用目录里的 label
        const childRow = list?.byId?.[childId] ?? {
          id: childId,
          displayTitle: typeof child?.label === 'string' && child.label !== '' ? child.label : childId
        }
        take(childId, childRow)
      }
    }
  } else {
    // 兜底：老的宿主没有 sessionStatus 时，退化成只看会话摘要上的 running 标志
    // （子代理活跃度仍从 projectionsBySession 读，读不到就是原来的行为）
    for (const id of Object.keys(rows)) {
      if (rows[id].running === true || runningChildCount(list, id, status) > 0) running.push({ id, row: rows[id] })
    }
  }

  const byRecency = (a, b) => at(b.row) - at(a.row)
  running.sort(byRecency)
  unread.sort(byRecency)
  pending.sort(byRecency)

  return {
    running,
    unread,
    pending,
    byKind,
    counts: { running: running.length, unread: unread.length, pending: pending.length }
  }
}

/** 状态 → 情绪（安静优先：没在跑就睡觉，不折腾）。 */
function pickEmotion(state) {
  if (state.counts.pending > 0) return 'waiting'
  if (state.counts.running > 0) return 'busy'
  if (state.counts.unread > 0) return 'celebrate'
  return 'dozing'
}

/* ────────────────────────────── 组件实现 ────────────────────────────── */

function buildStyle() {
  const el = document.createElement('style')
  el.id = HUD_STYLE_ID
  el.textContent = `
/* 容器尺寸**只由宠物决定**（width/height = 宠物盒），气泡绝对定位挂在外面。
   之前用 flex + align-items:flex-end，气泡一显示就把容器撑宽，宠物被挤到右边去了。 */
#${HUD_ID} { position: fixed; z-index: 60; width: ${HUD_SIZE}px; height: ${HUD_SIZE}px; user-select: none; }
#${HUD_ID} .hud-pet { position: absolute; inset: 0; cursor: grab; filter: drop-shadow(0 6px 14px rgba(0,0,0,.28)); }
#${HUD_ID} .hud-pet:active { cursor: grabbing; }
#${HUD_ID} .hud-pet img { width: 100%; height: 100%; object-fit: contain; pointer-events: none; -webkit-user-drag: none; }
#${HUD_ID} .hud-badge { position: absolute; top: 0; left: -2px; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; font: 600 11px/18px ui-sans-serif, system-ui, sans-serif; text-align: center; color: #fff; background: var(--dsw-alias-state-business-primary, #4d6bfe); box-shadow: 0 1px 4px rgba(0,0,0,.3); }
#${HUD_ID} .hud-badge[data-empty="1"] { display: none; }
#${HUD_ID} .hud-badge[data-tone="wait"] { background: var(--dsw-alias-state-warning-primary, #d9962b); }
#${HUD_ID} .hud-badge[data-tone="done"] { background: var(--dsw-alias-state-success-primary, #2f9e6b); }
#${HUD_ID} .hud-bubble { display: none; position: absolute; bottom: calc(100% + 8px); right: 0; min-width: 176px; max-width: min(280px, 62vw); padding: 9px 11px; border-radius: 12px; background: var(--dsw-alias-bg-elevated, rgba(28,30,36,.92)); color: var(--dsw-alias-label-primary, #e9eaee); border: 1px solid var(--dsw-alias-border-secondary, rgba(255,255,255,.14)); backdrop-filter: blur(10px); box-shadow: 0 8px 24px rgba(0,0,0,.35); font: 12px/1.5 ui-sans-serif, system-ui, sans-serif; }
#${HUD_ID} .hud-bubble::after { content: ''; position: absolute; right: 26px; top: 100%; width: 9px; height: 9px; transform: translateY(-5px) rotate(45deg); background: inherit; border-right: 1px solid var(--dsw-alias-border-secondary, rgba(255,255,255,.14)); border-bottom: 1px solid var(--dsw-alias-border-secondary, rgba(255,255,255,.14)); }
#${HUD_ID}[data-open="1"] .hud-bubble { display: block; }
#${HUD_ID} .hud-line { display: flex; align-items: center; gap: 6px; padding: 3px 5px; border-radius: 7px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#${HUD_ID} .hud-line[data-clickable="1"] { cursor: pointer; }
#${HUD_ID} .hud-line[data-clickable="1"]:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,.07)); }
#${HUD_ID} .hud-line[data-zero="1"] { opacity: .45; }
#${HUD_ID} .hud-line b { font-weight: 600; }
#${HUD_ID} .hud-sub { opacity: .62; font-size: 11px; }
#${HUD_ID} .hud-foot { margin-top: 5px; padding-top: 5px; border-top: 1px solid var(--dsw-alias-border-secondary, rgba(255,255,255,.12)); opacity: .5; font-size: 10px; text-align: right; }
#${HUD_ID} .hud-toast { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); padding: 7px 12px; border-radius: 9px; background: rgba(20,22,26,.94); color: #fff; font: 12px/1.4 ui-sans-serif, system-ui, sans-serif; box-shadow: 0 6px 20px rgba(0,0,0,.4); pointer-events: none; z-index: 61; }
`
  return el
}

class SessionHud {
  constructor(ctx) {
    this.ctx = ctx
    this.disposed = false
    this.state = { running: [], unread: [], pending: [], byKind: {}, counts: { running: 0, unread: 0, pending: 0 } }
    this.emotion = 'dozing'
    this.dragging = false
    this.open = false
    this.cursor = { running: 0, unread: 0, pending: 0 }
    this.disposers = []
    this.retryTimer = null
    this.pollTimer = null
    this.build()
    this.subscribe()
    this.render()
  }

  build() {
    const root = document.createElement('div')
    root.id = HUD_ID
    root.dataset.open = '0'

    const pet = document.createElement('div')
    pet.className = 'hud-pet'
    pet.title = 'DSH 会话状态（拖动可移动 · 单击展开气泡）'

    const img = document.createElement('img')
    img.alt = '会话状态挂件'
    img.draggable = false
    pet.appendChild(img)

    const badge = document.createElement('span')
    badge.className = 'hud-badge'
    badge.dataset.empty = '1'
    pet.appendChild(badge)

    const bubble = document.createElement('div')
    bubble.className = 'hud-bubble'

    root.appendChild(bubble)
    root.appendChild(pet)
    document.body.appendChild(root)

    this.root = root
    this.petEl = pet
    this.imgEl = img
    this.badgeEl = badge
    this.bubbleEl = bubble

    // 位置：默认右下角，可拖动并记忆。尺寸与 CSS 里的宠物盒保持一致。
    const prefs = readPrefs()
    const size = this.size()
    const pos = prefs.x !== undefined && prefs.y !== undefined
      ? clampToViewport(prefs.x, prefs.y, size, size)
      : { x: window.innerWidth - size - 24, y: window.innerHeight - size - 24 }
    this.applyPos(pos.x, pos.y)

    this.bindPointer()
    this.bindResize()
  }

  /** 宠物的实际盒子尺寸（测不到就退回 CSS 常量）。 */
  size() {
    try {
      const r = this.root?.getBoundingClientRect?.()
      if (r && r.width > 0 && r.height > 0) return Math.max(r.width, r.height)
    } catch {
      /* 忽略 */
    }
    return HUD_SIZE
  }

  applyPos(x, y) {
    this.pos = { x, y }
    this.root.style.left = x + 'px'
    this.root.style.top = y + 'px'
    this.root.style.right = 'auto'
    this.root.style.bottom = 'auto'
  }

  bindResize() {
    const onResize = () => {
      if (!this.pos) return
      const size = this.size()
      const p = clampToViewport(this.pos.x, this.pos.y, size, size)
      this.applyPos(p.x, p.y)
    }
    window.addEventListener('resize', onResize)
    this.disposers.push(() => window.removeEventListener('resize', onResize))
  }

  bindPointer() {
    let dragging = false
    let moved = 0
    let start = null

    const down = (ev) => {
      if (ev.button !== 0) return
      dragging = true
      moved = 0
      start = { x: ev.clientX, y: ev.clientY, px: this.pos.x, py: this.pos.y }
      this.dragging = true
      this.render()
      this.petEl.setPointerCapture?.(ev.pointerId)
    }
    const move = (ev) => {
      if (!dragging || !start) return
      const dx = ev.clientX - start.x
      const dy = ev.clientY - start.y
      moved = Math.max(moved, Math.abs(dx) + Math.abs(dy))
      const p = clampToViewport(start.px + dx, start.py + dy, this.size(), this.size())
      this.applyPos(p.x, p.y)
    }
    const up = (ev) => {
      if (!dragging) return
      dragging = false
      this.dragging = false
      this.petEl.releasePointerCapture?.(ev.pointerId)
      if (moved < 4) {
        // 视为点击：切换气泡
        this.setOpen(!this.open)
      } else if (this.pos) {
        writePrefs({ x: this.pos.x, y: this.pos.y })
      }
      start = null
      this.render()
    }

    this.petEl.addEventListener('pointerdown', down)
    this.petEl.addEventListener('pointermove', move)
    this.petEl.addEventListener('pointerup', up)
    this.petEl.addEventListener('pointercancel', up)

    this.disposers.push(() => {
      this.petEl.removeEventListener('pointerdown', down)
      this.petEl.removeEventListener('pointermove', move)
      this.petEl.removeEventListener('pointerup', up)
      this.petEl.removeEventListener('pointercancel', up)
    })
  }

  setOpen(next) {
    this.open = next
    this.root.dataset.open = next ? '1' : '0'
    if (next) this.render()
  }

  subscribe() {
    const bound = new Set()
    this.bound = bound

    const bind = (svc, path) => {
      try {
        const usable = svc && typeof svc.getSnapshot === 'function' && typeof svc.subscribe === 'function'
        if (!usable) return false
        if (bound.has(path)) return true
        const un = svc.subscribe(() => this.onChange())
        if (typeof un === 'function') this.disposers.push(un)
        bound.add(path)
        return true
      } catch (err) {
        hudLog('subscribe failed', path, err)
        return false
      }
    }

    const attempt = () => {
      let ok = true
      try {
        if (!bind(this.ctx.get('uiSession')?.sessionStatus, 'uiSession.sessionStatus')) ok = false
      } catch {
        ok = false
      }
      try {
        if (!bind(this.ctx.get('sessions')?.list, 'sessions.list')) ok = false
      } catch {
        ok = false
      }
      // workspaces 只是用来过滤归档，拿不到不算失败
      try {
        bind(this.ctx.get('workspaces')?.list, 'workspaces.list')
      } catch {
        /* 忽略 */
      }
      return ok
    }

    if (attempt()) {
      hudLog('已订阅数据源')
      return
    }

    // 服务尚未就绪：短退避重试；仍不行则退化为 3 秒低频兜底轮询（只在订阅没建立
    // 起来时才启用，成本可忽略）。这一层是为了不再出现「永远读到 0」这种静默失败。
    let tries = 0
    const retry = () => {
      if (this.disposed) return
      tries += 1
      if (attempt()) {
        hudLog('重试 ' + tries + ' 次后订阅成功')
        this.render()
        return
      }
      if (tries < 10) {
        this.retryTimer = setTimeout(retry, 300 * tries)
      } else {
        hudLog('订阅始终未建立，退化为 3 秒轮询兜底')
        this.pollTimer = setInterval(() => {
          if (this.disposed) return
          attempt()
          this.render()
        }, 3000)
      }
    }
    this.retryTimer = setTimeout(retry, 120)
  }

  onChange() {
    this.render()
  }

  /* ── 渲染 ── */
  render() {
    if (!this.root || !this.root.isConnected) return
    let state
    try {
      state = readState(this.ctx)
    } catch (err) {
      hudLog('readState failed', err)
      return
    }
    const prev = this.state
    this.state = state

    // 拖拽时优先播拖拽动画，其余按状态选；只在变化时换 src，避免动图被反复重播
    const emotion = this.dragging ? 'drag' : pickEmotion(state)
    if (emotion !== this.emotion || !this.imgEl.src) {
      this.emotion = emotion
      const src = this.asset(emotion)
      if (src) this.imgEl.src = src
    }

    // 角标：优先显示"待你选择"，其次"进行中"，再次"完成未读"
    let badgeN = 0
    let tone = 'run'
    if (state.counts.pending > 0) {
      badgeN = state.counts.pending
      tone = 'wait'
    } else if (state.counts.running > 0) {
      badgeN = state.counts.running
      tone = 'run'
    } else if (state.counts.unread > 0) {
      badgeN = state.counts.unread
      tone = 'done'
    }
    this.badgeEl.dataset.empty = badgeN > 0 ? '0' : '1'
    this.badgeEl.dataset.tone = tone
    this.badgeEl.textContent = badgeN > 9 ? '9+' : String(badgeN)
    this.badgeEl.title = '待选择 ' + state.counts.pending + ' · 进行中 ' + state.counts.running + ' · 完成未读 ' + state.counts.unread

    if (this.open) this.renderBubble(state)
    if (prev.counts.pending !== state.counts.pending) hudLog('pending', prev.counts.pending, '->', state.counts.pending)
  }

  renderBubble(state) {
    const frag = document.createDocumentFragment()

    /**
     * 造一行。全程用 DOM API 构造，不用 innerHTML —— 扩展源给的文本是外部输入，
     * 拼 HTML 会有注入面。
     * @param count 数字；给 undefined 表示这一行不带数字（扩展行）
     * @param dim   置灰（数字为 0 时）
     */
    const mk = ({ icon, count, label, extra, onClick, dim }) => {
      const line = document.createElement('div')
      line.className = 'hud-line'
      line.dataset.zero = dim ? '1' : '0'
      const clickable = typeof onClick === 'function' && !dim
      if (clickable) {
        line.dataset.clickable = '1'
        line.addEventListener('click', onClick)
      }
      const ic = document.createElement('span')
      ic.textContent = icon
      line.appendChild(ic)

      const tx = document.createElement('span')
      if (typeof count === 'number') {
        // 0 也要显示出来：只写「个在跑」读起来像坏了
        const b = document.createElement('b')
        b.textContent = String(count)
        tx.appendChild(b)
        const space = document.createElement('span')
        space.textContent = ' '
        tx.appendChild(space)
      }
      const lab = document.createElement('span')
      lab.textContent = label
      tx.appendChild(lab)
      line.appendChild(tx)

      if (extra) {
        const ex = document.createElement('span')
        ex.className = 'hud-sub'
        ex.textContent = extra
        line.appendChild(ex)
      }
      return line
    }

    const num = (icon, count, label, extra, onClick) =>
      mk({ icon, count, label, extra, onClick, dim: count === 0 })

    frag.appendChild(num('🌊', state.counts.running, '个在跑', '', () => this.jump('running')))
    frag.appendChild(num('✅', state.counts.unread, '个没看', '', () => this.jump('unread')))

    const kindBits = Object.keys(state.byKind)
      .map((k) => state.byKind[k] + ' ' + (PENDING_SHORT[k] ?? PENDING_UNKNOWN))
      .join(' · ')
    frag.appendChild(num('⚠️', state.counts.pending, '个等你选', kindBits ? '(' + kindBits + ')' : '', () => this.jump('pending')))

    // 扩展点：其它插件注册的气泡内容（如日程播报）
    const extra = [...bubbleSources.values()].sort((a, b) => (a.order ?? 50) - (b.order ?? 50))
    for (const src of extra) {
      let lines = []
      try {
        lines = src.getLines(this.state) ?? []
      } catch (err) {
        hudLog('source failed', src.id, err)
      }
      for (const l of lines) {
        if (!l || !l.text) continue
        frag.appendChild(mk({
          icon: l.icon ?? '•',
          count: typeof l.count === 'number' ? l.count : undefined,
          label: l.text,
          extra: l.sub ?? '',
          dim: false,
          onClick: typeof l.onClick === 'function' ? () => l.onClick(this.state) : null
        }))
      }
    }

    const foot = document.createElement('div')
    foot.className = 'hud-foot'
    foot.textContent = '单击数字跳转 · v' + HUD_VERSION
    frag.appendChild(foot)

    this.bubbleEl.replaceChildren(frag)
  }

  asset(emotion) {
    return PET_ANIM?.[emotion] ?? PET_ANIM?.dozing ?? ''
  }

  /** 跳到该分类下的会话；多次点击依次轮换。 */
  jump(kind) {
    const list = this.state[kind] ?? []
    if (list.length === 0) return
    const idx = (this.cursor[kind] ?? 0) % list.length
    const target = list[idx]
    this.cursor[kind] = idx + 1
    const ok = this.openSession(target.id)
    const row = target.row ?? {}
    const title = row.displayTitle || row.title || target.id
    const suffix = list.length > 1 ? '（' + (idx + 1) + '/' + list.length + '，再点下一个）' : ''
    this.toast((ok ? '→ ' : '✗ 无法跳转: ') + title + suffix)
    if (ok) this.setOpen(false)
  }

  openSession(id) {
    try {
      const ui = this.ctx.get('uiWorkspace')
      if (ui && typeof ui.openSession === 'function') {
        ui.openSession(id)
        return true
      }
      const sessions = this.ctx.get('sessions')
      if (sessions && typeof sessions.open === 'function') {
        sessions.open(id)
        return true
      }
    } catch (err) {
      hudLog('openSession failed', err)
    }
    return false
  }

  toast(text) {
    const el = document.createElement('div')
    el.className = 'hud-toast'
    el.textContent = text
    document.body.appendChild(el)
    setTimeout(() => el.remove(), 1800)
  }

  dispose() {
    this.disposed = true
    if (this.retryTimer !== null) clearTimeout(this.retryTimer)
    if (this.pollTimer !== null) clearInterval(this.pollTimer)
    this.retryTimer = null
    this.pollTimer = null
    for (const d of this.disposers) {
      try {
        d()
      } catch (err) {
        hudLog('dispose step failed', err)
      }
    }
    this.disposers = []
    this.root?.remove()
    instances.delete(this)
  }
}

/* ────────────────────────────── 插件入口 ────────────────────────────── */

function ensureStyle() {
  if (document.getElementById(HUD_STYLE_ID)) return
  document.head.appendChild(buildStyle())
}

let singleton = null

function apply(ctx) {
  ensureStyle()

  // 单例：HMR 或重复挂载时不叠第二只
  if (singleton) {
    instances.add(singleton)
    singleton.render()
    return () => {
      singleton?.dispose()
      singleton = null
    }
  }

  const hud = new SessionHud(ctx)
  singleton = hud
  instances.add(hud)
  hudLog('mounted v' + HUD_VERSION)

  // 留给后续功能的公共接口（日程播报等）
  window.__dshSessionHud = {
    version: HUD_VERSION,
    registerBubbleSource,
    refresh: refreshAll,
    get state() {
      return hud.state
    },
    get prefs() {
      return readPrefs()
    },
    credit: PET_CREDIT,
    emotions: PET_EMOTIONS,
    open(id) {
      return hud.openSession(id)
    },
    show(open = true) {
      hud.setOpen(open)
    },
    unmount() {
      hud.dispose()
      singleton = null
    }
  }

  return () => {
    hud.dispose()
    singleton = null
    try {
      delete window.__dshSessionHud
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 注入声明。**必须是数组**，不是函数！
 *
 * v0.1.0 把它写成了 `function inject() { return [...] }`，结果注入门控没生效，
 * apply 抢在服务就绪前执行 —— 三个数字永远读到 0（页面上表现为「个在跑」没数字）。
 * 官方两个同位置插件也都是数组：pet-whale 是 ["sessions","locale","uiConversation","uiSession"]，
 * dsh-personal-center 是 ["slots","locale","sessions","workspaces"]。
 *
 * 这里只注入确实需要的两个；workspaces / uiWorkspace 用 ctx.get() 取并做空值保护，
 * 免得某个服务一旦不存在就永远不 apply（那样会静默不挂载，比读不到数更难查）。
 */
const inject = ['sessions', 'uiSession']

exports.apply = apply
exports.inject = inject