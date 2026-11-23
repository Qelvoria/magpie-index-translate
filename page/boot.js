// 带路页：把 magpie 页面那个框架导航到插件的本地服务（lib/server.mjs）。
//
// 必须盲跳，不能先探测：页面 CSP 是 connect-src 'none'，连 no-cors 的请求都会被拒，
// 「先探一下服务在不在」永远得到 false。端口和 index.mjs 里 serve() 用的是同一个值。
//
// 顺带把窗口的主题和设计令牌交给页面服务，那边的界面就不用自己维护一套配色。
// wails.localhost 是桌面窗口自己的 assetserver，.localhost 一律当本机。
function isLoopback(host) {
  const name = String(host || "").toLowerCase().replace(/^\[|\]$/g, "")
  return name === "" || name === "localhost" || name.endsWith(".localhost") || name === "::1" || /^127\./.test(name)
}

(async () => {
  const DEFAULT_PORT = 3919
  const said = document.getElementById("said")
  const query = new URLSearchParams()

  let port = DEFAULT_PORT
  let service = ""

  try {
    const theme = await window.magpie?.ready
    if (typeof theme?.dark === "boolean") query.set("theme", theme.dark ? "dark" : "light")
    if (theme?.tokens && Object.keys(theme.tokens).length) {
      query.set("tokens", btoa(unescape(encodeURIComponent(JSON.stringify(theme.tokens)))))
    }
  } catch {} // 没有 bridge 就用默认主题

  try {
    const s = window.magpie?.service
    if (typeof s === "string" && /^https?:\/\//.test(s)) service = s
  } catch {} // 旧版 magpie 没有 service

  try {
    const options = await window.magpie?.options?.get?.()
    if (Number(options?.port) > 0) port = Number(options.port)
  } catch {}

  const base = service || `http://127.0.0.1:${port}/`
  const target = base + (base.includes("?") ? "&" : "?") + query.toString()

  // 桌面窗口的页面是从 http://wails.localhost 提供的（Wails 的 assetserver），
  // 它也算本机。只有 magpie web 部署在另一台电脑上时，这里的 127.0.0.1 才指向
  // 看页面那台机器——那才需要提示端口转发。
  if (!service && !isLoopback(location.hostname)) {
    said.textContent = `页面服务只监听跑 magpie 那台机器的 127.0.0.1:${port}；从这台电脑连不到。做一次端口转发，或改用桌面窗口。`
    return
  }

  location.replace(target)
})()
