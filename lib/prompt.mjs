// Index-Translate 的 instTrans 提示词构造。
//
// 逐字对齐官方 inference/llm/call_api.py 里的 build_prompt()：约束文案、
// 分隔符、结尾句、JSON 保护后缀都保持一致，这样插件拼出来的请求和官方
// 脚本发出去的字节相同。改动这里之前先看一眼 bridge/call_api.py。
//
// 唯一一处例外：给了术语表时，第二条约束是插件自己加的限定句（见 buildPrompt 里的注释），
// 不加的话术语会被硬塞进无关的译文。

// 与 call_api.py 的 LANG_NAMES 保持同步（代码 -> 中文名）。
export const LANG_NAMES = {
  en: "英语", zh: "中文", de: "德语", fr: "法语", es: "西班牙语",
  ja: "日语", ko: "韩语", pt: "葡萄牙语", ru: "俄语", ar: "阿拉伯语",
  it: "意大利语", nl: "荷兰语", pl: "波兰语", ro: "罗马尼亚语",
  sv: "瑞典语", tr: "土耳其语", hi: "印地语", vi: "越南语",
  th: "泰语", id: "印尼语", ms: "马来语", fil: "菲律宾语",
  ukr_cyrl: "乌克兰语", fas_arab: "波斯语", ces_latn: "捷克语",
  ell_grek: "希腊语", dan_latn: "丹麦语", hun_latn: "匈牙利语",
  fin_latn: "芬兰语", nob_latn: "书面挪威语", slk_latn: "斯洛伐克语",
  bul_cyrl: "保加利亚语",
}

const SEPARATORS = ["->", "→", ":", "："]

const langName = (code) => LANG_NAMES[String(code ?? "").trim().toLowerCase()]
const nameOrCode = (code) => langName(code) ?? code

// 术语表：JSON 字典、"a:b, c->d, e→f" 形式的对。
// 与 call_api.py::parse_glossary_terms 同构（"文件路径"那一支在插件里没有意义，略去）。
export function parseGlossary(input) {
  const raw = String(input ?? "").trim()
  if (!raw) return []
  if (raw.startsWith("{") && raw.endsWith("}")) {
    try {
      const data = JSON.parse(raw)
      if (data && typeof data === "object" && !Array.isArray(data)) {
        return Object.entries(data).map(([k, v]) => `${String(k).trim()}→${String(v).trim()}`)
      }
    } catch {}
  }
  const out = []
  for (const item of raw.replace(/，/g, ",").split(",")) {
    const s = item.trim()
    if (!s) continue
    const sep = SEPARATORS.find((x) => s.includes(x))
    if (!sep) {
      out.push(s)
      continue
    }
    const i = s.indexOf(sep)
    out.push(`${s.slice(0, i).trim()}→${s.slice(i + sep.length).trim()}`)
  }
  return out
}

function isJsonObject(text) {
  const s = text.trim()
  if (!s.startsWith("{") || !s.endsWith("}")) return false
  try {
    const v = JSON.parse(s)
    return !!v && typeof v === "object" && !Array.isArray(v)
  } catch {
    return false
  }
}

// buildPrompt 是 call_api.py::build_prompt 的镜像。
// 目标语言未知时原样返回正文，不去猜。
export function buildPrompt(text, targetLang, sourceLang = "auto", instruction = "", glossary = "", genre = "文本") {
  const tgt = langName(targetLang)
  const body = String(text ?? "").trim()
  if (!tgt) return body

  const srcCode = String(sourceLang ?? "").trim()
  const hasSource = !!srcCode && !["auto", ""].includes(srcCode.toLowerCase())
  const src = hasSource ? nameOrCode(srcCode) : ""

  const constraints = []
  const terms = parseGlossary(glossary)
  if (terms.length) {
    constraints.push(`【硬性要求】专名/术语对照: ${terms.join("、")}`)
    // 官方 build_prompt 没有这句。不加的话，术语会被硬塞进无关的译文：译入语和原文同语种时
    // "今天天气真好" 会变成 "今天天气真好，手仕舞（截止日期）快到了。"（实测 35B，temperature=0）。
    constraints.push("【注意】只在源文中出现该术语时按对照翻译，源文没有的不要加进译文。")
  }
  for (const line of String(instruction ?? "").trim().split(/\r?\n/)) {
    // Python: line.strip().lstrip("0123456789. ")
    const s = line.trim().replace(/^[0-9.\s]+/, "")
    if (!s) continue
    constraints.push(/^【(硬性要求|注意|软性要求)】/.test(s) ? s : `【注意】${s}`)
  }

  if (constraints.length) {
    const header = `请将以下${src ? src + genre : genre}翻译成${tgt}，并且严格遵循所有约束要求。`
    const req = constraints.map((c, i) => `${i + 1}. ${c}`).join("\n")
    const suffix =
      isJsonObject(body) && constraints.some((c) => /json/i.test(c))
        ? "请以相同的 JSON 格式输出翻译结果，key 保持不变，value 为对应译文。只输出 JSON，不要有任何额外说明。"
        : "只输出译文，不要有任何额外说明。"
    return `${header}\n\n【源文】\n${body}\n\n【约束要求】\n${req}\n\n${suffix}`
  }
  if (src) return `请将以下${src}文本翻译为${tgt}，直接输出翻译结果，不要进行任何解释。\n\n${body}`
  return `请将以下文本翻译为${tgt}，直接输出翻译结果，不要进行任何解释。\n\n${body}`
}

// 图片翻译的提示词（call_api.py 的 --image 分支）。
export function buildImagePrompt(targetLang, sourceLang = "auto", extra = "") {
  const tgt = nameOrCode(targetLang)
  const srcCode = String(sourceLang ?? "").trim()
  const src = srcCode && srcCode.toLowerCase() !== "auto" ? nameOrCode(srcCode) : ""
  const base = src
    ? `请将图片中的${src}文本翻译为${tgt}，直接输出翻译结果，不要进行任何解释。`
    : `请将图片中的文本翻译为${tgt}，直接输出翻译结果，不要进行任何解释。`
  return extra ? `${base}\n\n${extra}\n\n只输出翻译结果，不要进行任何解释。` : base
}

export function stripThink(text) {
  if (typeof text !== "string") return text
  return text.includes("</think>")
    ? text.slice(text.indexOf("</think>") + "</think>".length).trim()
    : text.replace(/^<think>/, "").trim()
}

const TRANSLATION_RE =
  /翻译|翻譯|译成|譯成|译为|譯為|翻成|译一下|translate|translation|translate[d]? (?:in)?to|locali[sz]e/i

// 客户端自己已经交代了"要翻译"时，不再叠加指令。
export function looksLikeTranslationRequest(text) {
  return TRANSLATION_RE.test(String(text ?? ""))
}

const HAN = /[㐀-鿿]/g
const KANA = /[぀-ヿ]/g
const LATIN = /[A-Za-z]/g

// 没指定目标语种时：日文译成中文，中文译成英文，其余译成中文。
export function guessTarget(text) {
  const s = String(text ?? "")
  const han = (s.match(HAN) ?? []).length
  const kana = (s.match(KANA) ?? []).length
  const latin = (s.match(LATIN) ?? []).length
  if (kana > 0) return "zh"
  if (han > 0 && han >= latin) return "en"
  return "zh"
}

// 从 chat 消息的 content 里取出纯文本（content 可能是数组）。
export function messageText(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : (p?.text ?? "")))
      .filter(Boolean)
      .join("\n")
  }
  return ""
}
