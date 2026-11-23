// plugins.json 里本插件那一项：能不能认出来、改的时候有没有碰别的东西。
import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findEntry, patchOptions, readOptions } from "../lib/store.mjs"

const self = { name: "magpie-index-translate", dir: "D:\\bin\\index-translate" }

const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "it-store-"))
  const file = join(dir, "plugins.json")
  writeFileSync(
    file,
    JSON.stringify({
      plugins: [
        { spec: "@magpie-community/page-chat@latest" },
        { spec: "d:/bin/index-translate/", options: { target: "en", future: 1 } },
      ],
    }),
  )
  return file
}

test("路径大小写、斜杠、尾斜杠都不同也能认出自己", () => {
  const data = { plugins: [{ spec: "D:\\BIN\\index-translate" }] }
  expect(findEntry(data, self)).toBeDefined()
  expect(findEntry({ plugins: [{ spec: "magpie-index-translate" }] }, self)).toBeDefined()
  expect(findEntry({ plugins: [{ spec: "./other" }] }, self)).toBeUndefined()
})

test("读回来的就是那一项的 options", () => {
  expect(readOptions(fixture(), self)).toEqual({ target: "en", future: 1 })
})

test("plugins.json 里没这一项时返回 null，和“有这一项但没配置”区分开", () => {
  const dir = mkdtempSync(join(tmpdir(), "it-store-"))
  const file = join(dir, "plugins.json")
  writeFileSync(file, JSON.stringify({ plugins: [{ spec: "@magpie-community/page-chat@latest" }] }))
  expect(readOptions(file, self)).toBeNull()
  expect(readOptions(file, { ...self, name: "whatever" })).toBeNull()
})

test("只改自己那几个键：别人的键、别的插件都不动", () => {
  const file = fixture()
  // 页面只会交这三个键，base / future 是别人（magpie 编辑器）写的 —— 都得活着
  expect(patchOptions(file, self, { target: "zh", instruction: "", glossary: "" })).toEqual({
    target: "zh",
    instruction: "",
    glossary: "",
    future: 1,
  })

  const saved = JSON.parse(readFileSync(file, "utf8"))
  expect(saved.plugins[0]).toEqual({ spec: "@magpie-community/page-chat@latest" })
  expect(saved.plugins[1].options).toEqual({ target: "zh", instruction: "", glossary: "", future: 1 })
})

test("没提到的键不碰，null 才删这一个键", () => {
  const file = fixture()
  expect(patchOptions(file, self, { base: "http://127.0.0.1:8000/v1", target: null })).toEqual({
    base: "http://127.0.0.1:8000/v1",
    future: 1,
  })
  expect(patchOptions(file, self, { instruction: "使用正式书面语" })).toEqual({
    base: "http://127.0.0.1:8000/v1",
    future: 1,
    instruction: "使用正式书面语",
  })
})

test("合并完真的一个键都不剩，才把 options 整个删掉", () => {
  const file = fixture()
  patchOptions(file, self, { target: null, future: null })
  expect(JSON.parse(readFileSync(file, "utf8")).plugins[1]).toEqual({ spec: "d:/bin/index-translate/" })
})

test("找不到自己就报错，不瞎写", () => {
  const file = fixture()
  expect(() => patchOptions(file, { name: "nope", dir: "D:\\nowhere" }, {})).toThrow()
})
