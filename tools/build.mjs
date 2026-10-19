/**
 * 构建 dsh-session-hud 的 client bundle。
 *
 * 输出必须是**自包含单文件**：DSH 客户端模块系统把每个 bundle 当 factory 注册，
 * external 只解析冻结的基座模块表，相对 import 不在表里 —— 所以素材与逻辑必须
 * 拼进同一个文件，运行时形状照抄官方 bundle（见 README「为什么是单文件」）。
 *
 * 用法: node tools/build.mjs
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 插件根目录取脚本自身位置（tools/ 的上一级），不写绝对路径 ——
// 这样整包拷到任何磁盘/任何用户名下都能直接 `node tools/build.mjs`。
const HERE = fileURLToPath(new URL('..', import.meta.url))
const PET_DIR = join(HERE, 'assets/pet')
const WIDGET = join(HERE, 'src/widget.js')
const OUT = join(HERE, 'lib/client.js')
const ID = 'dsh-session-hud'

if (!existsSync(PET_DIR)) {
  console.error('找不到素材目录: ' + PET_DIR)
  console.error('素材由 agent-work/convert-pet.py 从 dsh-pet 的 webm 动画生成；见 README「素材来源」。')
  process.exit(1)
}

/**
 * 检查动图 WebP 的帧标志位，防止"帧叠加"回归。
 *
 * 每帧是一个 ANMF chunk，帧头最后 1 字节：
 *   bit0 blend   0 = 与前一帧 alpha 混合，1 = 直接覆盖
 *   bit1 dispose 0 = 画完保留，        1 = 恢复透明背景
 * 若**所有**帧都是 blend=0 且 dispose=0，浏览器会把每一帧叠在上一帧上 ——
 * ffmpeg 的 libwebp 封装恰好就会写出这种文件（本插件踩过这个坑，
 * 换 Pillow 的 WebPAnimEncoder 编码后 dispose=1 才正常）。
 */
function checkAnimFlags(buf) {
  let frames = 0
  let allNoBlend = true
  let pos = 12
  while (pos + 8 <= buf.length) {
    const tag = buf.toString('latin1', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    if (tag === 'ANMF') {
      const flags = buf[pos + 8 + 15]
      if (flags & 1) allNoBlend = false
      frames += 1
    }
    pos += 8 + size + (size & 1)
  }
  return { frames, stacked: frames > 1 && allNoBlend }
}

// ── 1. 素材：读动图 WebP 并内联为 data URL ──────────────────────────
const WANT = ['dozing', 'busy', 'waiting', 'celebrate', 'drag']
const table = {}
let rawBytes = 0
for (const name of readdirSync(PET_DIR).filter((f) => f.endsWith('.webp')).sort()) {
  const key = name.replace(/\.webp$/, '')
  const buf = readFileSync(join(PET_DIR, name))
  const { frames, stacked } = checkAnimFlags(buf)
  if (stacked) {
    console.error(`✗ ${name}: 动画帧全部 blend=0/dispose=0，浏览器会把每帧叠着渲染。`)
    console.error('  请用 agent-work/convert-pet.py 重新生成（它走 Pillow 的 WebPAnimEncoder）。')
    process.exit(1)
  }
  rawBytes += buf.length
  table[key] = 'data:image/webp;base64,' + buf.toString('base64')
  console.log(`  ${key.padEnd(10)} ${String(frames).padStart(3)} 帧  ${(buf.length / 1024).toFixed(0)}KB  标志正常`)
}
for (const k of WANT) if (!table[k]) console.warn('  ⚠ 缺少素材: ' + k + '.webp')

const assetsFragment = [
  '// ── 宠物动画素材（由 tools/build.mjs 生成，勿手改）─────────────────────',
  '// 来源：dsh-pet  https://github.com/PC2005-cloud/dsh-pet',
  '//       作者 PC2005-cloud · MIT License',
  '//       原始素材为 640x360 带 alpha 的 VP9 webm 动画（README 载明由 AI 提示词',
  '//       → 绿幕视频 → 透明动画 的可复现素材链生成，素材由豆包生成）。',
  '//       本包用 agent-work/convert-pet.py 裁掉透明边并转成带 alpha 的动图 WebP，',
  '//       未改动画面内容。情绪键 → 原动画名：',
  '//         dozing=待机呼吸休闲  busy=写代码  waiting=工作状态-原地踱步张望',
  '//         celebrate=工作状态-雀跃庆祝  drag=被鼠标拖拽悬空反馈',
  'const PET_ANIM = ' + JSON.stringify(table) + ';',
  'const PET_EMOTIONS = ' + JSON.stringify(Object.keys(table)) + ';',
  'const PET_CREDIT = ' + JSON.stringify('dsh-pet (PC2005-cloud, MIT) · 动画素材 AI 生成') + ';',
  ''
].join('\n')

// ── 2. 逻辑 ────────────────────────────────────────────────────────
const widget = readFileSync(WIDGET, 'utf8').replace(/^\uFEFF/, '')

// ── 3. 按官方 bundle 形状包装 ──────────────────────────────────────
const head = [
  '/* dsh-session-hud client bundle — 由 tools/build.mjs 生成，勿直接编辑；请改 src/widget.js 后重新构建。 */',
  'window.__ModuleLoader__.load({',
  '\tid: ' + JSON.stringify(ID) + ',',
  '\tfactory: (require) => {',
  '\t\tvar module = { exports: {} };',
  '\t\tvar exports = module.exports;',
  '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
  ''
].join('\n')

const tail = ['\t\treturn module.exports;', '\t}', '});', ''].join('\n')

const bundled = head + '\n' + assetsFragment + '\n' + widget + '\n\n' + tail
writeFileSync(OUT, bundled, 'utf8')

const kb = (n) => (n / 1024).toFixed(0) + 'KB'
console.log('素材: ' + Object.keys(table).join(', '))
console.log('  webp 合计 ' + kb(rawBytes) + '  ->  内联后 ' + kb(bundled.length))
console.log('输出: ' + OUT + '  (' + kb(statSync(OUT).size) + ')')