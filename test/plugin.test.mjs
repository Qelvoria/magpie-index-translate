// bun test：插件每个请求怎么合成配置（index.mjs 的 liveOptions）。
// 只碰临时目录里的假 plugins.json，不发请求。
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { _internal } from "../index.mjs"

const { liveOptions } = _internal
const FALLBACK = {
  base: "https://index-translate.bilibili.com/v1",
  target: "auto",
  instruction: "",
  glossary: "",
}

// 把 XDG_CONFIG_HOME 指到临时目录，写一份只认得本插件的 plugins.json
function withOptions(options) {
  const dir = mkdtempSync(join(tmpdir(), "it-live-"))
  mkdirSync(join(dir, "magpie"), { recursive: true })
  const plugins = options === null ? [] : [{ spec: _internal.SELF.name, options }]
  writeFileSync(join(dir, "magpie", "plugins.json"), JSON.stringify({ plugins }), "utf8")
  process.env.XDG_CONFIG_HOME = dir
}

test("plugins.json 里写了什么就以什么为准", () => {
  withOptions({ target: "zh", glossary: "碳纤维:carbon fiber" })
  expect(liveOptions(FALLBACK)).toMatchObject({ target: "zh", glossary: "碳纤维:carbon fiber" })
})

test("改回默认（键被删掉）不会沿用加载时那份旧值", () => {
  // 以前这里 Object.keys(disk).length ? {...fallback, ...disk} : fallback，
  // 于是"把译入语从 zh 改回 auto"看着保存成功了，下一次翻译还是 zh
  withOptions({ glossary: "碳纤维:carbon fiber" })
  expect(liveOptions({ ...FALLBACK, target: "zh" })).toMatchObject({ target: "auto", glossary: "碳纤维:carbon fiber" })

  withOptions({ target: "", instruction: "" })
  expect(liveOptions({ ...FALLBACK, target: "zh" })).toMatchObject({ target: "", instruction: "" })
})

test("磁盘上没有这一项（OpenCode 内联配置）才用加载时那份", () => {
  withOptions(null)
  expect(liveOptions({ ...FALLBACK, target: "ja", base: "http://127.0.0.1:8000/v1" })).toEqual({
    base: "http://127.0.0.1:8000/v1",
    target: "ja",
    instruction: "",
    glossary: "",
  })
})
