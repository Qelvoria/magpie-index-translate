// 把 magpie 网关发来的 chat completions 请求改写成 Index-Translate 认得的形状。
//
// 网关按 agent 的协议把请求转成 OpenAI chat completions 交给插件的 fetch。
// Index-Translate 是指令微调模型：直接给它对话历史，它会当成聊天来问答
// （实测发一句原文，它回一大段闲聊）。这里做的事就是补上官方脚本那句
// "请将以下文本翻译为…"，并去掉翻译模型处理不了的东西（tools、工具选择等）。

import { buildImagePrompt, buildPrompt, guessTarget, messageText, stripThink } from "./prompt.mjs"

// 翻译模型不是通用对话模型，这些字段它不认，留着可能被 vLLM 拒绝或误导解码。
const DROP_FIELDS = ["tools", "tool_choice", "functions", "function_call", "response_format", "logit_bias", "stop", "seed"]

const textPart = (p) => {
  if (typeof p === "string") return p
  if (p && typeof p === "object") return p.text ?? p.content ?? ""
  return ""
}

const isImagePart = (p) =>
  !!p && typeof p === "object" && (p.type === "image_url" || p.type === "input_image" || !!p.image_url)

const isSystem = (m) => m?.role === "system" || m?.role === "developer"

// 中文名、英文名、常见写法都能认，值统一成 LANG_NAMES 里的代码。
const LANG_ALIASES = {
  chinese: "zh", 中文: "zh", 汉语: "zh", 简体中文: "zh", 繁体中文: "zh", zho: "zh", "zh-cn": "zh",
  english: "en", 英语: "en", 英文: "en", eng: "en",
  japanese: "ja", 日语: "ja", 日文: "ja", jpn: "ja",
  korean: "ko", 韩语: "ko", 韩文: "ko", 朝鲜语: "ko", kor: "ko",
  french: "fr", 法语: "fr", german: "de", 德语: "de", spanish: "es", 西班牙语: "es",
  russian: "ru", 俄语: "ru", portuguese: "pt", 葡萄牙语: "pt", italian: "it", 意大利语: "it",
  arabic: "ar", 阿拉伯语: "ar", thai: "th", 泰语: "th", vietnamese: "vi", 越南语: "vi",
  hindi: "hi", 印地语: "hi", dutch: "nl", 荷兰语: "nl", turkish: "tr", 土耳其语: "tr",
  indonesian: "id", 印尼语: "id", malay: "ms", 马来语: "ms", polish: "pl", 波兰语: "pl",
}

// 最后一条用户消息的正文与图片片段。
function lastUser(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== "user") continue
    const content = messages[i].content
    if (typeof content === "string") return { index: i, text: content, images: [] }
    if (Array.isArray(content)) {
      return {
        index: i,
        text: content.filter((p) => !isImagePart(p)).map(textPart).filter(Boolean).join("\n").trim(),
        images: content.filter(isImagePart),
      }
    }
    return { index: i, text: "", images: [] }
  }
  return { index: -1, text: "", images: [] }
}

// resolveTarget 决定这次请求译成什么语言：
//   1. 插件选项里写死的 target；
//   2. 原文里写明的目标语种（"翻译成日语"、"translate to Japanese"）；
//   3. 按原文脚本猜：日文 -> 中文，中文 -> 英文，其余 -> 中文。
export function resolveTarget(opts, text) {
  if (opts.target && opts.target !== "auto" && opts.target !== "") return opts.target
  const m = String(text ?? "").match(
    /(?:翻译|翻譯|译|譯|translate|translation)\s*(?:成|为|為|to|into)\s*([A-Za-z㐀-鿿]{1,12})/i,
  )
  if (m) {
    const hit = LANG_ALIASES[m[1].toLowerCase()]
    if (hit) return hit
  }
  return guessTarget(text)
}

// 客户端自己已经交代了"要翻译"（沉浸式翻译、用户直接说"翻译这段"）时，
// 照着它的要求做，不再叠加我们的指令。
//
// 只看关键词会把 agent 的编程提示误判成翻译要求：里面随手一句 "do not translate code"
// 就会让整条请求裸奔（实测返回的是闲聊而不是译文）。所以再加两条判据——
// 真的翻译提示很短（沉浸式翻译那类几百字），而且会点名目标语种或声明自己是翻译器。
const CLIENT_PROMPT_MAX = 1000

const TRANSLATION_TASK_RE =
  /(?:translate|translation|翻译|翻譯)[^\n。！？]{0,40}?(?:to|into|成|为|為)\s*[\w㐀-鿿]|(?:you are|you're|act as)\s+(?:a\s+)?(?:professional\s+)?translat|translation (?:engine|task|only)|翻译引擎|翻译助手|翻译器|只输出译文/i

const isTranslationPrompt = (content) => {
  const text = messageText(content).trim()
  return !!text && text.length <= CLIENT_PROMPT_MAX && TRANSLATION_TASK_RE.test(text)
}

function clientAskedForTranslation(messages) {
  if (messages.some((m) => isSystem(m) && isTranslationPrompt(m.content))) return true
  const last = messages.at(-1)
  return !!last && isTranslationPrompt(last.content)
}

// rewrite 是插件的主体：拿到网关给的 JSON 体，还回要发给上游的 JSON 体。
// opts 只有 base / target / instruction / glossary 四项，其余行为都是写死的官方默认。
// 返回 { payload, translated, target }。
export function rewrite(payload, opts = {}) {
  const out = { ...payload }
  const messages = Array.isArray(out.messages) ? out.messages : []

  // 翻译模型不认这些
  for (const k of DROP_FIELDS) delete out[k]
  if (out.n && out.n !== 1) out.n = 1

  // 关闭思维链：官方脚本对每个请求都注入这两项，否则 <think> 会顶掉译文。
  const kw = out.chat_template_kwargs && typeof out.chat_template_kwargs === "object" ? { ...out.chat_template_kwargs } : {}
  if (!("enable_thinking" in kw)) kw.enable_thinking = false
  out.chat_template_kwargs = kw
  if (out.temperature == null) out.temperature = 0

  const { text, images } = lastUser(messages)
  const target = resolveTarget(opts, text)

  // 由客户端自己给提示词（沉浸式翻译这类会自带"翻译成中文"的系统提示）：整套放行。
  if (clientAskedForTranslation(messages)) return { payload: out, translated: false, target }

  // 剩下的系统提示都是 agent 的编程提示词，对翻译模型只有干扰，一律丢掉。
  let finalMessages
  let translated = true
  if (images.length) {
    const extra = []
    // 图文一起发时正文当附加要求（官方脚本没有这条，但丢掉用户输入更糟）
    if (text) extra.push(text)
    if (opts.instruction) extra.push(`【指令要求】${opts.instruction}`)
    if (opts.glossary) extra.push(`【术语对照】${opts.glossary}`)
    const prompt = buildImagePrompt(target, "auto", extra.join("\n"))
    finalMessages = [{ role: "user", content: [{ type: "text", text: prompt }, ...images] }]
  } else if (text) {
    // 只翻译最后一条用户消息：前面的对话轮次对翻译模型没有帮助，反而会带偏。
    const prompt = buildPrompt(text, target, "auto", opts.instruction ?? "", opts.glossary ?? "")
    finalMessages = [{ role: "user", content: prompt }]
  } else {
    // 没有可翻译的正文（纯工具调用之类）：原样放行，让上游自己拒绝。
    translated = false
    finalMessages = messages
  }

  out.messages = finalMessages.length ? finalMessages : messages
  return { payload: out, translated, target }
}

// 非流式回答里如果还是出现了 <think>，顺手去掉，免得下游拿到思考文本。
export async function cleanResponse(res) {
  const ct = res.headers.get("content-type") ?? ""
  if (!ct.includes("application/json")) return res
  let text
  try {
    text = await res.text()
  } catch {
    return res
  }
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return new Response(text, { status: res.status, headers: withoutLength(res.headers) })
  }
  let changed = false
  for (const ch of body?.choices ?? []) {
    const msg = ch?.message
    if (msg && typeof msg.content === "string" && msg.content.includes("</think>")) {
      msg.content = stripThink(msg.content)
      changed = true
    }
  }
  if (!changed) return new Response(text, { status: res.status, headers: withoutLength(res.headers) })
  return new Response(JSON.stringify(body), { status: res.status, headers: withoutLength(res.headers) })
}

function withoutLength(headers) {
  const h = new Headers(headers)
  h.delete("content-length")
  h.delete("content-encoding")
  return h
}
