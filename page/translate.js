// 设置栏里「翻译」那一段：译入语 / 术语表 / 附加要求。
//
// 这三项存在 plugins.json 的 options 里，不是对话页自己的 settings.json ——
// lib/translate.mjs 的 rewrite() 每个请求读一次，所以这里保存完，下一次翻译就生效。
// 保存走的是按键合并：这一页只写自己那三个键，magpie 插件选项编辑器写的 base
// 和别的键一律不碰。归一化（语种清单、术语表逗号、空串照写）在 options.js 的
// window.ITO 里，这里不重写一遍。
;(() => {
  const $ = (id) => document.getElementById(id)
  const token = document.querySelector('meta[name="it-token"]')?.content ?? ""

  async function api(path, body) {
    const res = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", "x-it-token": token },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    return data
  }

  function say(text, kind) {
    const node = $("itStatus")
    node.textContent = text
    node.className = kind ? `set-tools-status ${kind}` : "set-tools-status"
  }

  function fill(options) {
    const o = options && typeof options === "object" ? options : {}
    const select = $("itTarget")
    const value = String(o.target ?? ITO.DEFAULTS.target)
    if (!Array.from(select.options).some((op) => op.value === value)) {
      select.appendChild(new Option(`${value}（清单外）`, value)) // 清单外的代码也别吞掉
    }
    select.value = value
    $("itGlossary").value = String(o.glossary ?? "")
    $("itInstruction").value = String(o.instruction ?? "")
  }

  async function save() {
    const now = {
      target: $("itTarget").value,
      glossary: $("itGlossary").value,
      instruction: $("itInstruction").value,
    }
    say("保存中…")
    try {
      const saved = await api("/api/translate/options", { options: ITO.toOptions(now) })
      fill(saved.options)
      say("已保存，下一次翻译就用新值。", "ok")
    } catch (err) {
      say(`保存失败：${err.message}`, "err")
    }
  }

  async function main() {
    const select = $("itTarget")
    select.appendChild(new Option("auto（按原文判断）", "auto"))
    for (const [code, name] of ITO.LANGS) select.appendChild(new Option(name, code))

    // 改完即存：app.js 那边的设置也是这个手感
    for (const id of ["itTarget", "itGlossary", "itInstruction"]) $(id).addEventListener("change", save)

    try {
      fill((await api("/api/translate/options")).options)
    } catch (err) {
      say(`读不到配置：${err.message}`, "err")
    }
  }

  main()
})()
