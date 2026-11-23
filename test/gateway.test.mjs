// bun test：页面 → 网关这一段里的纯逻辑，不访问网络。
import { expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { optionsPatch, pageToken, staticModels } from "../lib/server.mjs"

// ---- 翻译页 -> plugins.json 的按键合并 ----

test("这条路由只认页面那几个键：base 和别人的键一律不进来", () => {
  expect(
    optionsPatch({
      base: "http://127.0.0.1:8000/v1",
      port: 9999,
      target: " zh ",
      instruction: "正式书面语",
      glossary: "a:b",
    }),
  ).toEqual({ target: "zh", instruction: "正式书面语", glossary: "a:b" })
})

test("没提到的键不出现在 patch 里（合并时就不动它），null 才是删", () => {
  expect(optionsPatch({ target: "en" })).toEqual({ target: "en" })
  expect(optionsPatch({ target: null, glossary: null })).toEqual({ target: null, glossary: null })
})

test("body 不是对象、或压根没带 options：什么都不动", () => {
  for (const bad of [undefined, null, "target=zh", 42, {}]) {
    expect(optionsPatch(bad)).toEqual({})
  }
})

test("网关没起时的兜底清单：静态表，id 带供应商前缀", () => {
  const list = staticModels()
  expect(list.length).toBeGreaterThan(1)
  expect(list[0].id).toBe("index-translate/Index-Translate-35B-A3B")
  expect(list.every((m) => m.id.startsWith("index-translate/"))).toBe(true)
  // 界面要用到的字段都在
  expect(list[0]).toMatchObject({ provider: "index-translate", images: true, efforts: [] })
})

// ---- 页面口令：落盘复用，服务重启不换 ----

const tokenPath = (dir) => join(dir, "magpie-index-translate", "page-token")

test("同一个数据目录再取一次还是那份，重启后旧页面不用刷新", async () => {
  const dir = await mkdtemp(join(tmpdir(), "it-token-"))
  const first = await pageToken(dir)
  expect(first).toMatch(/^[0-9a-f]{48}$/)
  expect(await readFile(tokenPath(dir), "utf8")).toBe(first)
  expect(await pageToken(dir)).toBe(first)
})

test("口令文件被换掉就跟着换：页面揣着旧的会 403，由页面自己取回新口令重试", async () => {
  const dir = await mkdtemp(join(tmpdir(), "it-token-"))
  const old = await pageToken(dir)
  await writeFile(tokenPath(dir), "b".repeat(48))
  expect(await pageToken(dir)).toBe("b".repeat(48))
  expect(await pageToken(dir)).not.toBe(old)
})

test("口令文件是脏的就重新生成一份合法的，不拿它去当闸", async () => {
  const dir = await mkdtemp(join(tmpdir(), "it-token-"))
  await pageToken(dir)
  await writeFile(tokenPath(dir), "not-a-token\n")
  const fresh = await pageToken(dir)
  expect(fresh).toMatch(/^[0-9a-f]{48}$/)
  expect(await readFile(tokenPath(dir), "utf8")).toBe(fresh)
})
