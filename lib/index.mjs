/**
 * dsh-session-hud · 宿主半区
 *
 * 本插件的行为**全部在 client half**（浏览器侧）完成：它只消费 DSH 原生的
 * `sessions` / `uiSession` / `workspaces` / `uiWorkspace` 客户端服务，不注册
 * 任何宿主路由、不落盘、不联网。宠物素材以 base64 内联在 client 包里，因此
 * 也不需要宿主提供静态资源路由（这点与 dsh-personal-center 不同——它用回环
 * 路由送图，代价是局域网/手机端拉不到图）。
 *
 * 所以这里只需要一个空的 apply：占位以便 cordis.patch.yml 有一行可挂。
 */
export const name = 'dsh-session-hud'

export function apply() {
  // 有意为空：没有宿主侧行为。
}