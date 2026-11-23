// 表单 <-> options 的纯逻辑。页面沙箱里没有 import，靠 <script> 顺序挂到 window 上，
// 这样 test/page.test.mjs 也能直接跑这几个函数（不碰 DOM）。
window.ITO = (() => {
  // 这一页只拥有这几个键：lib/store.mjs 的 PAGE_KEYS / PAGE_DEFAULTS 是同一份清单
  // （沙箱里 import 不到，所以抄了一份，test/page.test.mjs 会比对两边别跑偏）。
  // base 和其它键都在 magpie 的插件选项编辑器里改，这里既不读也不写——
  // 以前整份替换着写，页面一保存就把不认识的键抹掉了。
  const KEYS = ["target", "instruction", "glossary"]
  const DEFAULTS = { target: "auto", instruction: "", glossary: "" }

  // 与 lib/prompt.mjs 的 LANG_NAMES 同名同码；只是下拉框的常用项，清单外的值照样保留。
  const LANGS = [
    ["zh", "中文"], ["en", "英语"], ["ja", "日语"], ["ko", "韩语"],
    ["de", "德语"], ["fr", "法语"], ["es", "西班牙语"], ["ru", "俄语"],
  ]

  // 换行和全角逗号先归一成 ", "：插件那边 parseGlossary 只认逗号分隔。
  const glossary = (value) =>
    String(value ?? "")
      .trim()
      .replace(/\r?\n/g, ",")
      .replace(/[，;；]/g, ",")
      .replace(/\s*,\s*/g, ", ")
      .replace(/^, |, $/g, "")

  // 表单值 -> 要合并进 plugins.json 的那几个键。三个键每次都写，清空就是空串：
  // 这样插件选项编辑器里始终看得见它们（以前默认值不落盘，页面保存一次编辑器就只剩
  // 一两项，看着像别的配置被删了）。没画的 base 不进这个对象，也就动不到它。
  function toOptions(values) {
    const v = values && typeof values === "object" ? values : {}
    const patch = {}
    for (const key of KEYS) {
      const raw = key === "glossary" ? glossary(v[key]) : String(v[key] ?? "").trim()
      patch[key] = key === "target" ? raw || DEFAULTS.target : raw // 译入语不能空着，空 = auto
    }
    return patch
  }

  return { KEYS, DEFAULTS, LANGS, toOptions }
})()
