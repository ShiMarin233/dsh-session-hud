# NOTICE — 第三方内容与来源声明

本插件的代码为原创，采用 MIT 许可（见 `LICENSE`）。
包内**唯一**的第三方内容是 5 个宠物动画素材。下面把「用了什么」「评估过但没用什么」「只参考了什么」分三张表写清楚，
以免任何读者（包括市场审核）误以为本包是多方素材的拼接。

---

## 一、本包实际使用

| 内容 | 出处 | 许可 | 我们对它做了什么 |
|---|---|---|---|
| 5 个宠物动画：`dozing` / `busy` / `waiting` / `celebrate` / `drag` | [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（作者 PC2005-cloud） | **MIT**，Copyright (c) 2026 PC2005-cloud | 从原仓库 5 个带 alpha 通道的 VP9 webm 透明动画中取帧，**裁掉透明边**并**转码为动图 WebP**（176px 宽 / 8fps / q45），**画面内容未改动** |

- 许可证全文：`assets/pet/LICENSE-dsh-pet.txt`（随包分发）
- 构建产物 `lib/client.js` 内亦内联了署名常量 `PET_CREDIT`（`dsh-pet (PC2005-cloud, MIT) · 动画素材 AI 生成`），
  运行时不会丢失署名
- 原仓库 README 载明其素材由「AI 提示词 → 绿幕视频 → 透明动画」的可复现链路生成（图像由豆包生成）

> 转换用的脚本（`convert-pet.py`）不属于本包的分发内容，仅记录了转换参数与踩过的坑（见 `README.md` §四）。

---

## 二、评估过但**未使用**（无任何代码或素材进入本包）

| 项目 | 为什么没用 |
|---|---|
| [dsh-whale-widget](https://github.com/MeteorNOX/dsh-whale-widget) | 其 `assets/**` 作者**明确声明不适用 MIT、不授予再许可**，因此其图片与音效一律未取 |
| `dsh-pet-live2d` | 其 Live2D 美术（`c_0120.moc3`、贴图、动作、截图）适用**单独许可，非 MIT**，未取 |
| `dsh-whale-pet-plugin`、`dsh-answer-pet`、`dsh-pet-git`、`dsh-pet-remielle`、`dsh-pet-live2d` 等候选 | 仅下载用于横向评估（对比动画质量、交互形态、许可可用性），**未取其代码或素材** |

以上项目在开发期被下载到开发工作区的 `agent-work/pet-candidates/`，该目录**不在本包内**。

---

## 三、仅参考交互口径、**未复制代码**

| 插件 | 许可 | 参考了什么 |
|---|---|---|
| [pet-whale](https://github.com/nzl153/dsh-pet-whale)（nzl153） | MIT | `inject` 声明形态、角标动画的实现思路（`README.md` §三 留作日后参考） |
| `dsh-activity-pane` | MIT | `pendingInteraction` 三分类（approval / plan-review / question）的展示用词口径 |
| `dsh-personal-center`（PolinniZhong） | MIT | 设置分区的插槽写法（留作日后参考） |

本包源码**不含**上述项目的任何代码。`src/widget.js` 中提及这些名字的语句**全部位于注释**，
用途是说明「本插件的口径与某某一致」。

**核验方法**（审核或读者可自行复现）：在包内搜索这些项目的标识符，只会命中注释与其许可说明 ——

```sh
grep -rn -E 'whale|pw-|live2d|activity-pane|personal-center|answer-pet' src/ lib/ tools/
```

---

## 四、官方 DeepSeek Harness

本插件消费 DSH 的公开客户端服务面（`sessions` / `uiSession` / `workspaces` / `uiWorkspace`），
不注册宿主路由、不落盘、不联网。

开发过程中阅读了 DSH 的发行代码以确认字段路径与状态口径（`README.md` 标注了出处行号），
**实现均为自行编写**：例如「进行中」的聚合口径与官方侧栏语义等价，但实现是独立的一遍循环
加全程类型检查与 `try/catch` 退化，而非复制官方表达式。

本包**不含任何 DSH 官方代码**，运行时也不复制其文件，仅通过公开 API 调用。

---

## 五、本插件自身

| | |
|---|---|
| 代码 | 原创，MIT（`LICENSE`） |
| 依赖 | **零** npm 依赖（`package.json` 无 `dependencies`，无 `scripts`） |
| 构建 | `node tools/build.mjs`，只用 Node 内置模块，产物 `lib/client.js` 自包含（素材以 base64 内联） |