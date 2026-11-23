// 设置页的表单逻辑（page/options.js）。它是给 <script> 用的经典脚本，挂 window.ITO，
// 所以这里塞一个假的 window 进去取，跑起来不需要 DOM。
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { PAGE_DEFAULTS, PAGE_KEYS } from "../lib/store.mjs"

const source = readFileSync(new URL("../page/options.js", import.meta.url), "utf8")
const ITO = new Function("window", `${source}\nreturn window.ITO`)({})

test("页面那三个键的清单和服务端一致", () => {
  // 沙箱页面 import 不到 store.mjs，只能各抄一份；抄歪了就会有一边以为写了、另一边没动
  expect(ITO.KEYS).toEqual(PAGE_KEYS)
  expect(ITO.DEFAULTS).toEqual(PAGE_DEFAULTS)
})

test("三个键每次都写全，清空是空串而不是缺席", () => {
  // plugins.json 里攒着空值没关系，插件选项编辑器因此始终看得见这三项
  expect(ITO.toOptions({ target: "auto", instruction: "", glossary: "" })).toEqual({
    target: "auto",
    instruction: "",
    glossary: "",
  })
})

test("译入语不接受空值：空 = auto", () => {
  expect(ITO.toOptions({ target: "" })).toMatchObject({ target: "auto" })
})

test("base 不在页面的清单里：magpie 编辑器写的那份动不到", () => {
  const patch = ITO.toOptions({ base: "http://127.0.0.1:8000/v1", target: "en" })
  expect("base" in patch).toBe(false)
  expect(patch.target).toBe("en")
})

test("术语表归一成逗号分隔，值两头去空格", () => {
  expect(
    ITO.toOptions({
      target: "en",
      instruction: "  使用正式书面语  ",
      glossary: "碳纤维：carbon fiber\n抗裂缝:crack resistance",
    }),
  ).toEqual({
    target: "en",
    instruction: "使用正式书面语",
    glossary: "碳纤维：carbon fiber, 抗裂缝:crack resistance",
  })
})
