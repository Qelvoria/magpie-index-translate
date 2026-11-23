#!/usr/bin/env bun
// 不经过 magpie，直接调一次 Index-Translate，用来确认配置/提示词对不对。
//
//   bun bin/cli.mjs "今天天气真好" -t en
//   bun bin/cli.mjs --image shot.png -t zh
//   bun bin/cli.mjs "碳纤维的好处是抗裂缝" -t en -g "碳纤维:carbon fiber, 抗裂缝:crack resistance"
//   bun bin/cli.mjs "..." -t zh --base http://127.0.0.1:8000/v1 --model Index-Translate-9B
//
// 真正的翻译逻辑和插件共用 lib/prompt.mjs，所以这里跑出来的就是 magpie 会发出的请求。

import { buildImagePrompt, buildPrompt, guessTarget } from "../lib/prompt.mjs"
import { BASE, MODELS } from "../lib/models.mjs"

const args = process.argv.slice(2)
const flag = (name, short) => {
  const i = args.findIndex((a) => a === `--${name}` || (short && a === `-${short}`))
  if (i < 0) return undefined
  const v = args[i + 1]
  args.splice(i, 2)
  return v
}
const has = (name, short) => {
  const i = args.findIndex((a) => a === `--${name}` || (short && a === `-${short}`))
  if (i < 0) return false
  args.splice(i, 1)
  return true
}

const base = (flag("base") ?? BASE).replace(/\/+$/, "")
const model = flag("model", "m") ?? MODELS[0].id
const image = flag("image", "i")
const instruction = flag("instruction", "n") ?? ""
const glossary = flag("glossary", "g") ?? ""
const genre = flag("genre", "d") ?? "文本"
const stream = has("stream", "s")
const source = flag("source") ?? "auto"
// -t 必须在拼 text 之前取走，否则 "… -t zh" 会把 -t 和 zh 当成正文。
const targetFlag = flag("target", "t")
const text = args.join(" ").trim()

if (!text && !image) {
  console.error(`用法: bun bin/cli.mjs "要翻译的文本" [-t zh] [-m ${MODELS[0].id}] [-g "a:b"] [--image 图片] [--stream]`)
  console.error(`可用模型: ${MODELS.map((m) => m.id).join(", ")}`)
  process.exit(2)
}

const target = targetFlag ?? (text ? guessTarget(text) : "zh")
const extra = [instruction && `【指令要求】${instruction}`, glossary && `【术语对照】${glossary}`].filter(Boolean).join("\n")

let content
if (image) {
  const bytes = await Bun.file(image).arrayBuffer().catch(() => null)
  if (!bytes) {
    console.error(`读不到图片: ${image}`)
    process.exit(1)
  }
  const mime = image.endsWith(".jpg") || image.endsWith(".jpeg") ? "image/jpeg" : image.endsWith(".webp") ? "image/webp" : "image/png"
  const dataUrl = `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`
  content = [
    { type: "text", text: buildImagePrompt(target, source, extra) },
    { type: "image_url", image_url: { url: dataUrl } },
  ]
} else {
  content = buildPrompt(text, target, source, instruction, glossary, genre)
}

const res = await fetch(`${base}/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model,
    messages: [{ role: "user", content }],
    temperature: 0,
    max_tokens: Number(flag("max-tokens") ?? 1024),
    stream,
    chat_template_kwargs: { enable_thinking: false },
  }),
})

if (!res.ok) {
  console.error(`上游返回 ${res.status}: ${(await res.text()).slice(0, 500)}`)
  process.exit(1)
}

if (!stream) {
  const body = await res.json()
  const msg = body.choices?.[0]?.message?.content ?? ""
  console.log(msg.trim())
  process.exit(0)
}

const decoder = new TextDecoder()
let buf = ""
for await (const chunk of res.body) {
  buf += decoder.decode(chunk, { stream: true })
  const lines = buf.split("\n")
  buf = lines.pop() ?? ""
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue
    const data = line.slice(6).trim()
    if (data === "[DONE]") process.exit(0)
    try {
      process.stdout.write(JSON.parse(data).choices?.[0]?.delta?.content ?? "")
    } catch {}
  }
}
console.log()
