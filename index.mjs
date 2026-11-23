// Index-Translate 的 magpie / OpenCode 供应商插件。
//
// 哔哩哔哩的 Index-Translate 是一个翻译大模型家族（150 语种、可带术语与格式
// 约束、35B 还支持图片），接口是标准 OpenAI chat completions，公网免费、不鉴权。
// 但它是指令微调模型：直接把对话丢过去，它会当成聊天来回答。所以这个插件
// 在 loader 的 fetch 里重写请求体，补上官方脚本那句"请将以下文本翻译为…"。
//
// 依赖：bridge/call_api.py 是官方脚本，只作为对照和 `--serve` 本地网桥的入口；
// 插件本身不启动它，也不需要 Python。

import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { BASE, MODELS, configModels, fetchModels } from "./lib/models.mjs"
import { startServer } from "./lib/server.mjs"
import { PAGE_DEFAULTS, PAGE_KEYS, pluginsFile, readOptions } from "./lib/store.mjs"
import { cleanResponse, rewrite } from "./lib/translate.mjs"

const PROVIDER = "index-translate"
const VERSION = "0.1.0"
const SELF = { name: "magpie-index-translate", dir: dirname(fileURLToPath(import.meta.url)) }
const DEFAULT_PORT = 3919

// 插件选项（plugins.json 里的 options，或 OpenCode 的 ["pkg", {…}]）：
//   base         上游地址，默认公网；自建 vLLM 时改成 http://127.0.0.1:8000/v1
//   target       固定译入语种（zh/en/ja…），"auto" 按原文判断
//   instruction  附加约束（对应官方脚本 --instruction）
//   glossary     术语表，"碳纤维:carbon fiber, 抗裂缝:crack resistance"（对应 --glossary）
//
// 其余参数（源语种、文体、temperature、思维链、系统提示、max_tokens）一律写死成官方
// 脚本的默认行为：它们几乎没人改，留着只是多几个要解释、要测的分支。
//
// 页面服务的端口也不是配置项：magpie 每次自己挑一个本机空闲端口，加载时通过 options.port
// 递进来（见 package.json 的 magpie.page.service.option）。只有脱离 magpie 单独跑才用
// DEFAULT_PORT 3919 兜底。

function optionsOf(options) {
  const o = options && typeof options === "object" ? options : {}
  return {
    base: String(o.base ?? BASE).replace(/\/+$/, ""),
    target: o.target ?? "auto",
    instruction: o.instruction ?? "",
    glossary: o.glossary ?? "",
  }
}

// 试翻页经网关打的就是这里，所以每个请求重读一次磁盘：抽屉里改完立刻生效，不用 off/on。
function liveOptions(fallback) {
  let disk
  try {
    disk = readOptions(pluginsFile(), SELF)
  } catch {
    disk = null // plugins.json 读不到：多半不是 magpie 装的，用加载时那份
  }
  if (!disk) return fallback // 没有这一项（OpenCode 的 ["pkg", {…}]）也别拿默认值盖掉内联配置
  const merged = { ...fallback, ...disk }
  // 这一项里没有某个键 = 没人设过它，或者被 magpie 编辑器/null 删掉了：
  // 按默认算，不能沿用加载时那份旧值（那是上一次保存的值，会让"清空"变成"改了没反应"）。
  for (const key of PAGE_KEYS) if (!(key in disk)) merged[key] = PAGE_DEFAULTS[key]
  return optionsOf(merged)
}

// 请求体可能是字符串，也可能是字节。
function bodyText(body) {
  if (typeof body === "string") return body
  if (body == null) return ""
  try {
    return new TextDecoder().decode(body)
  } catch {
    return ""
  }
}

// 页面服务（lib/server.mjs）只起一次：带路页盲跳 127.0.0.1:port，配置和试翻都在那边。
// 不 await：端口被另一个宿主占着时要等它松手，等在这儿会把插件加载拖到超时。
let serving = null
function serve(options) {
  if (serving) return serving
  const port = Number(options?.port) > 0 ? Number(options.port) : DEFAULT_PORT
  serving = startServer({ self: SELF, options: { port } })
    .then((info) => {
      console.log(`[index-translate] 页面服务 http://127.0.0.1:${info.port}/`)
      return info
    })
    .catch((err) => {
      console.error("[index-translate] 页面服务起不来：", err?.message ?? err)
      return null
    })
  return serving
}

export const IndexTranslatePlugin = async (_input, options) => {
  const opts = optionsOf(options)
  serve({ ...opts, port: options?.port })

  return {
    // 声明供应商与模型；??= 是不覆盖用户在 plugins.json 里写的配置。
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: "Index-Translate",
        // chat completions 协议：网关会把各 agent 的请求都转成这个格式
        npm: "@ai-sdk/openai-compatible",
        api: opts.base,
        models: configModels(),
      }
    },

    auth: {
      provider: PROVIDER,
      // 公网接口不鉴权，一个账户槽就够，重复登录覆盖而不是新建。
      single: true,
      methods: [
        {
          type: "api",
          label: "Index-Translate（公网免费，无需 key）",
          // magpie 的扩展：api 方法带 authorize 时置 keyless，宿主会跳过输入框，
          // 点一下登录即可。凭据由下面这个函数给出（见 magpie internal/plugin/host.js）。
          keyless: true,
          authorize: async () => ({ type: "success", key: "index" }),
        },
      ],
      // 每个账号的每个请求都过这里，改写的核心就在这段 fetch。
      async loader(getAuth) {
        const auth = await getAuth().catch(() => undefined)
        const key = auth?.type === "api" ? (auth.key ?? "") : ""
        const base = opts.base
        return {
          baseURL: base,
          apiKey: key || "index",
          async fetch(input, init) {
            const url = typeof input === "string" ? input : (input?.url ?? String(input))
            const raw = bodyText(init?.body)
            if (!raw) return fetch(input, init)

            let payload
            try {
              payload = JSON.parse(raw)
            } catch {
              return fetch(input, init)
            }

            const { payload: next } = rewrite(payload, liveOptions(opts))
            const headers = new Headers(init?.headers ?? {})
            headers.set("content-type", "application/json")

            const res = await fetch(url, { ...init, headers, body: JSON.stringify(next) })
            // 流式回答原样透传；非流式的顺手清掉可能残留的 <think>。
            if (next.stream) return res
            return cleanResponse(res).catch(() => res)
          },
        }
      },
    },

    // 每个账号问一次上游有哪些模型。失败就返回原列表，magpie 会保留上次的。
    provider: {
      id: PROVIDER,
      async models(provider) {
        let list
        try {
          list = await fetchModels({ base: opts.base })
        } catch {
          list = null
        }
        if (!list) return provider.models
        const known = Object.fromEntries(MODELS.map((m) => [m.id, m]))
        const templates = provider.models ?? {}
        const out = {}
        for (const m of list) {
          const id = m.id ?? m.name
          if (!id) continue
          const meta = known[id]
          const base = templates[id] ?? templates["Index-Translate-9B"] ?? { tool_call: false, reasoning: false }
          out[id] = { ...base, id, name: meta?.name ?? id }
        }
        return Object.keys(out).length ? out : provider.models
      },
    },
  }
}

// 供 bun test / 手动调试用；放对象上，别直接从入口导出函数。
export const _internal = { PROVIDER, VERSION, optionsOf, bodyText, liveOptions, SELF }
