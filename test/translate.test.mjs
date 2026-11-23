// bun test：验证请求改写与提示词构造，不访问网络。
import { expect, test } from "bun:test"
import { buildPrompt, guessTarget, parseGlossary, stripThink } from "../lib/prompt.mjs"
import { resolveTarget, rewrite } from "../lib/translate.mjs"

test("无约束提示词与官方脚本一致", () => {
  expect(buildPrompt("Hello world", "zh")).toBe("请将以下文本翻译为中文，直接输出翻译结果，不要进行任何解释。\n\nHello world")
  expect(buildPrompt("Hello", "zh", "en")).toBe("请将以下英语文本翻译为中文，直接输出翻译结果，不要进行任何解释。\n\nHello")
})

test("约束提示词用 instTrans 格式", () => {
  const p = buildPrompt("碳纤维抗裂缝", "en", "auto", "使用正式书面语", "碳纤维:carbon fiber")
  expect(p.startsWith("请将以下文本翻译成英语，并且严格遵循所有约束要求。")).toBe(true)
  expect(p).toContain("【源文】\n碳纤维抗裂缝")
  expect(p).toContain("1. 【硬性要求】专名/术语对照: 碳纤维→carbon fiber")
  expect(p).toContain("2. 【注意】只在源文中出现该术语时按对照翻译")
  expect(p).toContain("3. 【注意】使用正式书面语")
  expect(p.endsWith("只输出译文，不要有任何额外说明。")).toBe(true)
})

test("没有术语表就不加那句限定（字节与官方一致）", () => {
  expect(buildPrompt("Hello", "zh", "auto", "使用正式书面语")).not.toContain("只在源文中出现该术语")
})

test("JSON 源文 + JSON 约束换成 JSON 输出指令", () => {
  const p = buildPrompt('{"a":"你好"}', "en", "auto", "保持 JSON 格式")
  expect(p).toContain("请以相同的 JSON 格式输出翻译结果")
})

test("术语表三种写法", () => {
  expect(parseGlossary("a:b, c->d, e→f")).toEqual(["a→b", "c→d", "e→f"])
  expect(parseGlossary('{"碳纤维":"carbon fiber"}')).toEqual(["碳纤维→carbon fiber"])
  expect(parseGlossary("")).toEqual([])
})

test("语种猜测：中文出英、英文出中、日文出中", () => {
  expect(guessTarget("今天天气真好")).toBe("en")
  expect(guessTarget("Hello there, how are you")).toBe("zh")
  expect(guessTarget("こんにちは")).toBe("zh")
})

test("原文里写明的语种优先于猜测", () => {
  expect(resolveTarget({}, "请把这句话翻译成日语")).toBe("ja")
  expect(resolveTarget({ target: "fr" }, "随便什么")).toBe("fr")
})

test("改写：去掉 tools、关思考、包上翻译指令、丢弃编程系统提示", () => {
  const { payload, translated, target } = rewrite({
    model: "m",
    messages: [
      { role: "system", content: "You are Claude Code, a coding agent." },
      { role: "user", content: "今天天气真好" },
    ],
    tools: [{ type: "function" }],
    stream: false,
  })
  expect(translated).toBe(true)
  expect(target).toBe("en")
  expect(payload).not.toHaveProperty("tools")
  expect(payload.chat_template_kwargs).toEqual({ enable_thinking: false })
  expect(payload.temperature).toBe(0)
  expect(payload.messages).toHaveLength(1)
  expect(payload.messages[0].content).toContain("请将以下文本翻译为英语")
})

test("客户端自带翻译提示时原样放行", () => {
  const { payload, translated } = rewrite({
    model: "m",
    messages: [
      { role: "system", content: "You are a translator. Translate to Chinese." },
      { role: "user", content: "Hello" },
    ],
  })
  expect(translated).toBe(false)
  expect(payload.messages).toHaveLength(2)
})

test("系统提示里顺带出现 translate 不算客户端翻译要求", () => {
  const { payload, translated } = rewrite({
    model: "m",
    messages: [
      { role: "system", content: "You are Claude Code, a coding agent. Do not translate code." },
      { role: "user", content: "今天天气真好" },
    ],
  })
  expect(translated).toBe(true)
  expect(payload.messages).toHaveLength(1)
  expect(payload.messages[0].content).toContain("请将以下文本翻译为英语")
})

test("超长系统提示里的翻译要求同样不算", () => {
  const { translated } = rewrite({
    model: "m",
    messages: [
      { role: "system", content: `${"rule. ".repeat(300)}Translate markers in logs.` },
      { role: "user", content: "Hello" },
    ],
  })
  expect(translated).toBe(true)
})

test("多模态请求保留图片片段", () => {
  const { payload } = rewrite({
    model: "m",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
        ],
      },
    ],
  }, { target: "zh" })
  const parts = payload.messages[0].content
  expect(Array.isArray(parts)).toBe(true)
  expect(parts[0].type).toBe("text")
  expect(parts[0].text).toContain("请将图片中的文本翻译为中文")
  expect(parts[1].type).toBe("image_url")
})

test("图文一起发时正文进图片提示词，不被丢掉", () => {
  const { payload } = rewrite(
    {
      model: "m",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "只翻标红的部分" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
          ],
        },
      ],
    },
    { target: "zh" },
  )
  const prompt = payload.messages[0].content[0].text
  expect(prompt).toContain("请将图片中的文本翻译为中文")
  expect(prompt).toContain("只翻标红的部分")
})

test("stripThink 去掉思维链", () => {
  expect(stripThink("<think>嗯</think>译文")).toBe("译文")
  expect(stripThink("译文")).toBe("译文")
})
