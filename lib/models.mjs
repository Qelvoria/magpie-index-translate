// Index-Translate 的模型表。README 里只有名字，参数是从 /v1/models 读来的
// （2026-10 实测，用途见 README「模型」，这张表在页面/网关里怎么用见 AGENTS.md）。

export const BASE = "https://index-translate.bilibili.com/v1"

// list 是上游 /v1/models 的模型；这里再带上用途说明，供模型选择器显示。
export const MODELS = [
  {
    id: "Index-Translate-35B-A3B",
    name: "Index-Translate 35B-A3B（旗舰）",
    context: 24576,
    output: 4096,
    image: true,
    note: "150 语种，支持图片翻译，质量最好",
  },
  {
    id: "Index-Translate-9B",
    name: "Index-Translate 9B（均衡）",
    context: 32768,
    output: 4096,
    image: false,
    note: "文本翻译主力，速度与质量均衡",
  },
  {
    id: "Index-Translate-2B",
    name: "Index-Translate 2B（轻量）",
    context: 32768,
    output: 4096,
    image: false,
    note: "最快，适合网页/字幕这类高频短文本",
  },
  {
    id: "Index-Nailong-9B",
    name: "Index-NativeLong 9B（长文档）",
    context: 229376,
    output: 229376,
    image: false,
    note: "整篇文档翻译，跨段术语一致（固定 zh↔en/ja 方向）",
  },
  {
    id: "Index-Nailong-2B",
    name: "Index-NativeLong 2B（长文档）",
    context: 262144,
    output: 262144,
    image: false,
    note: "长文档轻量版",
  },
  {
    id: "Index-Homura-9B",
    name: "Index-Homura 9B（音节受控）",
    context: 32768,
    output: 4096,
    image: false,
    note: "配音/字幕用，译文限制在指定音节数",
  },
  {
    id: "Index-Homura-2B",
    name: "Index-Homura 2B（音节受控）",
    context: 32768,
    output: 4096,
    image: false,
    note: "音节受控的轻量版",
  },
]

// 给 config 钩子用的 OpenCode Model 形状。
export function configModels() {
  const out = {}
  for (const m of MODELS) {
    out[m.id] = {
      name: m.name,
      limit: { context: m.context, output: m.output },
      // 翻译模型不调用工具，也没有思考档位
      tool_call: false,
      reasoning: false,
      temperature: true,
      ...(m.image ? { modalities: { input: ["text", "image"], output: ["text"] } } : {}),
    }
  }
  return out
}

// 问上游要一次模型列表；失败就返回 null，由调用方保留原列表。
// 上游不鉴权，但仍然带上 Authorization，方便用户把 BASE 改成自建的 vLLM。
export async function fetchModels({ base = BASE, apiKey = "", signal } = {}) {
  const res = await fetch(`${base.replace(/\/+$/, "")}/models`, {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    signal,
  })
  if (!res.ok) return null
  const body = await res.json().catch(() => null)
  const list = Array.isArray(body?.data) ? body.data : []
  return list.length ? list : null
}
