// plugins.json 里本插件那一项的 options：读、按键合并写。
//
// 页面服务用它把配置写回 magpie 的配置目录（与 magpie 自己 `plugin options` 写的是
// 同一处），别的插件不动、本次没提到的键也不动。写之前先写临时文件再改名，避免写一半
// 断电留下半个 plugins.json。
import { readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export function pluginsFile() {
  const dir = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return join(dir, "magpie", "plugins.json")
}

const norm = (path) =>
  String(path ?? "")
    .replace(/[\\/]+/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase()

// 本插件那一项：路径装的比目录，npm/git 装的比包名（magpie 的 spec 就是其中之一）。
export function findEntry(data, self) {
  const list = Array.isArray(data?.plugins) ? data.plugins : []
  return list.find((entry) => {
    const spec = String(entry?.spec ?? "")
    return !!spec && (spec === self.name || norm(spec) === norm(self.dir))
  })
}

// 翻译页拥有的那几个键，和它们的默认行为。页面只写这几个，别的键（base 和以后新加的）
// 归 magpie 的插件选项编辑器写——两边各写各的键，谁都不会把对方的抹掉。
// page/options.js 的 ITO.KEYS / ITO.DEFAULTS 是同一份清单（沙箱页面 import 不到这里，
// 改动时要一起改，test/page.test.mjs 会盯着它们别跑偏）。
export const PAGE_KEYS = ["target", "instruction", "glossary"]

// 没写这个键时插件的行为。index.mjs 每个请求合成配置时用：plugins.json 里没这个键
// = 从没设过或被删掉了，一律按默认，不能沿用加载时那份旧值。
export const PAGE_DEFAULTS = { target: "auto", instruction: "", glossary: "" }

// 这一项的 options。plugins.json 里根本没有这个插件时返回 null（和"有这一项但没写配置"
// 区分开：前者是 OpenCode 那种把配置内联在 ["pkg", {…}] 里的装法，不该被默认值盖掉）。
export function readOptions(file, self) {
  const data = JSON.parse(readFileSync(file, "utf8"))
  const entry = findEntry(data, self)
  return entry ? { ...(entry.options ?? {}) } : null
}

// 按键合并：patch 里出现的键才动，值是 null 就把这个键删掉，其余原样写回（空串也留着，
// 表示"这一项被清空过"，插件选项编辑器里还能看见它）。
// 以前这里是整份替换，页面一保存就把它没画的键（base）一起抹了 —— magpie 的插件选项
// 编辑器于是只剩一两项，另一方填的配置看着像凭空消失。
export function patchOptions(file, self, patch) {
  const data = JSON.parse(readFileSync(file, "utf8"))
  const entry = findEntry(data, self)
  if (!entry) throw new Error(`plugins.json 里没有 ${self.name} 这一项`)

  const next = { ...(entry.options ?? {}) }
  for (const [key, value] of Object.entries(patch && typeof patch === "object" ? patch : {})) {
    if (value === undefined) continue // 没提到 = 不动这个键
    if (value === null) delete next[key] // 明确要删（CLI 里传 null）
    else next[key] = value
  }

  if (Object.keys(next).length) entry.options = next
  else delete entry.options

  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8")
  renameSync(tmp, file)
  return next
}
