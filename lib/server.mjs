// 对话页背后的本地服务（只监听 127.0.0.1）。
//
// 来源：参照 magpie-chat（MIT）的 lib/server.mjs，底子取自 commit 82f4fd9。
// 它是参照，不是必须跟齐的上游——下面这些改动是为"翻译工具"做的取舍，上游再更新也不必同步，
// 但别把它们改回去。其余（路由、SSE、会话持久化、CORS/Origin 判断、静态服务、端口策略）沿用上游：
//
//   1. 去掉 MCP 客户端与工具循环（翻译模型不调用工具，rewrite() 也会把 tools 删掉）；
//   2. 去掉 library.mjs 的指令/技能拼接（系统提示对翻译模型只有干扰，rewrite() 会丢弃）；
//   3. 加回本项目的口令闸：/api/* 要 x-it-token，静态 html 注入口令（口令落盘复用，
//      服务重启不换，见 pageToken）；
//   4. 请求体只留 model + messages，temperature/maxTokens/思考档位一律不发——
//      官方脚本固定 temperature=0、关思维链，由 lib/translate.mjs 统一注入；
//      上游 settings 里的 system / instructions / skills / mcp / temperature / maxTokens /
//      effort 七个键连同界面和 /api/library、/api/mcp/tools 一起删了（页面没控件、没人读）；
//   5. 端口 3919；数据目录 magpie-index-translate；模型清单就是网关 /v1/models
//      （所有供应商、只含勾选过的），网关没起才退回本插件静态表；
//   6. 新增 /api/translate/options：译入语/术语表/附加要求仍写 plugins.json，
//      但只按这几个键合并（optionsPatch + patchOptions），整份替换会抹掉 magpie
//      编辑器写的 base，见 store.mjs。
//
// 升级上游时按 commit 重新对比这几个差异点，别把这些改回去。
import { createServer } from "node:http";
import { readFile, writeFile, readdir, rm } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { chatCompletions, gatewayURL, listModels, resolveGateway, sseChunks } from "./gateway.mjs";
import { MODELS } from "./models.mjs";
import { patchOptions, PAGE_KEYS, pluginsFile, readOptions } from "./store.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const UI_ROOT = join(here, "..", "chat");
const PAGE_ROOT = join(here, "..", "page");
const PROVIDER = "index-translate";
const TOKEN_HEADER = "x-it-token";
const TOKEN_SLOT = "__IT_TOKEN__";

// 页面里那两个我们自己的脚本，和对话页同源提供（省得再开一个静态根）
const EXTRA_STATIC = {
  "/options.js": join(PAGE_ROOT, "options.js"),
  "/translate.js": join(PAGE_ROOT, "translate.js"),
};

const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version || "";
  } catch {
    return "";
  }
})();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function configDir() {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, "magpie");
  return join(homedir(), ".config", "magpie");
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

// ---- 设置与对话：存在 magpie 配置目录下，跟插件自己的数据放一起 ----
function dataDir(configDirPath) {
  const dir = join(configDirPath || configDir(), "magpie-index-translate");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

// ---- 页面口令 ----
// 原本每次启动随机一份：magpie 里那一页还是上一个进程留下的文档时，它揣着旧口令来敲
// 新进程，/api/* 全 403，用户只能手动刷新。改成落盘复用——同一个数据目录里口令不变，
// 服务重启、插件 off/on、宿主换进程，旧页面照样能用。
// 口令只挡"本机别的页面来乱调这个端口"，第一道闸仍是 Origin 判断；文件放在用户配置
// 目录里，POSIX 下 0600。读写失败就退回本次进程的内存口令，功能不受影响（页面重载即可）。
const TOKEN_FILE = "page-token";
const TOKEN_RE = /^[0-9a-f]{48}$/;

export async function pageToken(configDirPath) {
  const p = join(dataDir(configDirPath), TOKEN_FILE);
  try {
    const saved = (await readFile(p, "utf8")).trim();
    if (TOKEN_RE.test(saved)) return saved;
  } catch { /* 第一次跑，还没有这个文件 */ }
  const fresh = randomBytes(24).toString("hex");
  try {
    await writeFile(p, fresh, { mode: 0o600 });
  } catch { /* 写不进去就用内存里这份 */ }
  return fresh;
}

// 从 magpie 的 settings.json 读用户设的字体，拼成覆盖 :root 的 CSS。
// 没设就返回空串，页面用自己的兜底字体栈。
async function fontCss() {
  const UI_FALLBACK = '-apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif';
  const CODE_FALLBACK = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
  const quote = (s) => '"' + String(s).replace(/["\\\x00-\x1f]/g, "") + '"';
  const parts = [];
  try {
    const s = JSON.parse(await readFile(join(configDir(), "settings.json"), "utf8"));
    const has = (f) => f && typeof f.family === "string" && f.family.trim();
    if (has(s.uiFont)) {
      const f = s.uiFont;
      // 字体名后面接 magpie 自己的基础栈：找不到那个字体时逐级回落
      parts.push(`--font: ${quote(f.family)}, ${UI_FALLBACK};`);
      if (Number.isFinite(f.weight) && f.weight >= 1 && f.weight <= 1000) parts.push(`--font-weight: ${f.weight};`);
      if (["normal", "italic", "oblique"].includes(f.style)) parts.push(`--font-style: ${f.style};`);
      if (Number.isFinite(f.stretch) && f.stretch > 0) parts.push(`--font-stretch: ${f.stretch}%;`);
    }
    if (has(s.codeFont)) {
      const c = s.codeFont;
      parts.push(`--code: ${quote(c.family)}, ${CODE_FALLBACK};`);
      if (Number.isFinite(c.weight) && c.weight >= 1 && c.weight <= 1000) parts.push(`--code-weight: ${c.weight};`);
    }
  } catch {
    return ""; // 读不到设置就用页面自己的兜底
  }
  return parts.length ? `:root { ${parts.join(" ")} }` : "";
}

// [fork] 上游这里还带 effort / system / instructions / skills / mcp / temperature / maxTokens
// 七个键。翻译页没有对应的控件（那几段设置和思考档位按钮都删了），/api/chat 也不读它们：
// rewrite() 固定 temperature=0、关思维链、丢 tools 和系统提示。留着只是让 settings.json
// 攒一堆谁都不看的字段，整块删掉。
const DEFAULTS = {
  model: "", showReasoning: true,
  pinned: [],       // 置顶的对话 id，按置顶顺序排在列表最前
  sidebar: true,    // 左侧栏是否展开
  settingsOpen: false, // 右侧设置栏是否打开
  leftWidth: 0,     // 左侧栏宽度（0 = 用默认值）
  rightWidth: 0,    // 设置栏宽度（0 = 用默认值）
  convWidth: 72,    // 会话内容列宽度（%），100 = 铺满
  composerWidth: 70, // 输入框宽度（%）
  syncWidth: false, // 布局里的"同步调整"：打开后两个宽度始终一致
};

function cleanSettings(raw) {
  const s = { ...DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
  return {
    model: String(s.model || ""),
    showReasoning: s.showReasoning !== false,
    pinned: Array.isArray(s.pinned) ? s.pinned.map(String).filter(Boolean).slice(0, 200) : [],
    sidebar: s.sidebar !== false,
    settingsOpen: s.settingsOpen === true,
    leftWidth: Number.isFinite(Number(s.leftWidth)) ? Math.max(0, Math.min(420, Number(s.leftWidth))) : 0,
    rightWidth: Number.isFinite(Number(s.rightWidth)) ? Math.max(0, Math.min(560, Number(s.rightWidth))) : 0,
    convWidth: Number.isFinite(Number(s.convWidth)) ? Math.max(0, Math.min(100, Number(s.convWidth))) : 72,
    composerWidth: Number.isFinite(Number(s.composerWidth)) ? Math.max(35, Math.min(100, Number(s.composerWidth))) : 70,
    syncWidth: s.syncWidth === true,
  };
}

export function createStore(configDirPath) {
  const dir = dataDir(configDirPath);
  const settingsPath = join(dir, "settings.json");
  const convDir = join(dir, "conversations");
  if (!existsSync(convDir)) mkdirSync(convDir, { recursive: true });

  const store = {
    dir,
    async settings() {
      return cleanSettings(await readJson(settingsPath, {}));
    },
    async saveSettings(patch) {
      const next = cleanSettings({ ...(await store.settings()), ...(patch || {}) });
      await writeFile(settingsPath, JSON.stringify(next, null, 2));
      return next;
    },
    convPath(id) {
      const safe = String(id || "").replace(/[^\w-]/g, "").slice(0, 64);
      return safe ? join(convDir, safe + ".json") : "";
    },
    async getConversation(id) {
      const p = store.convPath(id);
      if (!p) return null;
      return readJson(p, null);
    },
    async saveConversation(conv) {
      const id = conv.id || "c_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      const messages = Array.isArray(conv.messages) ? conv.messages.slice(-400) : [];
      const title = String(conv.title || firstLine(messages) || "新对话").slice(0, 90);
      const out = { id, title, updated: Date.now(), messages };
      const p = store.convPath(id);
      if (!p) throw new Error("bad conversation id");
      await writeFile(p, JSON.stringify(out));
      return out;
    },
    async listConversations() {
      const names = await readdir(convDir).catch(() => []);
      const items = [];
      for (const n of names) {
        if (!n.endsWith(".json")) continue;
        const c = await readJson(join(convDir, n), null);
        if (!c?.id) continue;
        const last = [...(c.messages || [])].reverse().find((m) => m.role === "user");
        items.push({ id: c.id, title: c.title, updated: c.updated || 0, preview: String(last?.content || "").slice(0, 120) });
      }
      // 置顶的排在前面（按置顶顺序），其余按最近更新
      const pinned = (await store.settings()).pinned || [];
      const rank = new Map(pinned.map((id, i) => [id, i]));
      return items.sort((a, b) => {
        const ra = rank.has(a.id) ? rank.get(a.id) : -1;
        const rb = rank.has(b.id) ? rank.get(b.id) : -1;
        if (ra >= 0 && rb >= 0) return ra - rb;
        if (ra >= 0) return -1;
        if (rb >= 0) return 1;
        return b.updated - a.updated;
      }).map((item) => ({ ...item, pinned: rank.has(item.id) }));
    },
    async removeConversation(id) {
      const p = store.convPath(id);
      if (p) await rm(p, { force: true });
    },
  };
  return store;
}

// 没有图标文件时生成的首字母徽章：颜色按名字散列，同一供应商总是同一色
function letterIcon(name) {
  const s = String(name || "?");
  let hue = 0;
  for (let i = 0; i < s.length; i++) hue = (hue * 31 + s.charCodeAt(i)) % 360;
  const ch = s.slice(0, 1).toUpperCase().replace(/[<&>"]/g, "");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
<rect width="32" height="32" rx="7" fill="hsl(${hue}, 52%, 88%)"/>
<text x="16" y="16" text-anchor="middle" dominant-baseline="central"
      font-family="-apple-system, Segoe UI, sans-serif" font-size="16" font-weight="600"
      fill="hsl(${hue}, 52%, 30%)">${ch}</text></svg>`;
}

function firstLine(messages) {
  const u = (messages || []).find((m) => m.role === "user");
  const text = String(u?.content || "").trim().replace(/\s+/g, " ");
  return text.slice(0, 60);
}

// ---- HTTP ----
// magpie 的插件页面跑在 sandbox="allow-scripts" 的框架里，origin 是 opaque，
// 浏览器发来的 Origin 就是字面量 "null"。直接在地址栏打开同一个服务时，Origin 是本服务自己。
// 其他来源一律拒绝。Origin 之外还有一道口令：本机任意网页也能造出 Origin: null。
let OWN = new Set();

function originAllowed(req) {
  const o = req.headers.origin;
  return o === undefined || o === "null" || OWN.has(o);
}

function corsHeaders(req) {
  const o = req.headers?.origin;
  const allow = o === "null" ? "null" : o && OWN.has(o) ? o : "null";
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-headers": `content-type, ${TOKEN_HEADER}`,
    // 必须列全：浏览器对 PATCH 这类非简单方法会先发 OPTIONS 预检，
    // 这里没列出来的方法，预检就过不去，前端只会看到 "Failed to fetch"。
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    vary: "Origin",
  };
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  const data = typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    ...corsHeaders(res.req),
    "x-content-type-options": "nosniff",
  });
  res.end(data);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 24 * 1024 * 1024) throw new Error("请求太大");
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("请求不是合法的 JSON");
  }
}

function sseHead(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    ...corsHeaders(res.req),
    "x-accel-buffering": "no",
  });
  res.flushHeaders?.();
}

function sse(res, type, data) {
  if (res.writableEnded) return;
  res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}

// 一条消息转成网关认的 content：
// 没有图片就是字符串；有图片就变成 [{type:"text"},{type:"image_url",image_url:{url}}]
// （image_url 收 data: URL，magpie 网关会原样转给上游）。
function toGatewayContent(m) {
  const text = String(m.content ?? "");
  const files = Array.isArray(m.files) ? m.files : [];
  const images = files.filter((f) => f && f.kind === "image" && f.data);
  if (!images.length) return text;
  const parts = [];
  if (text.trim()) parts.push({ type: "text", text });
  for (const img of images) {
    parts.push({ type: "image_url", image_url: { url: String(img.data) } });
  }
  // 非图片附件以文字交代给模型，避免它不知道用户放了文件
  const others = files.filter((f) => f && f.kind !== "image");
  if (others.length) {
    parts.push({ type: "text", text: others.map((f) => `[附件] ${f.name || "文件"}（${f.size || 0} 字节）`).join("\n") });
  }
  return parts;
}

// 一轮翻译：只发 model + messages，指令/温度/关思维链全由 lib/translate.mjs 的 rewrite() 补。
// 历史照发不误——rewrite() 只取最后一条用户消息，前面的轮次它自己会丢掉。
async function runChat({ res, body, settings }, controllers) {
  const clientId = String(body.clientId || "");
  const abort = new AbortController();
  if (clientId) controllers.set(clientId, abort);
  res.on("close", () => { if (!res.writableEnded) abort.abort(); });

  const started = Date.now();
  const model = String(body.model || settings.model || "");
  const history = Array.isArray(body.messages)
    ? body.messages.filter((m) => m && (m.role === "user" || m.role === "assistant"))
    : [];
  // 只挂了图片/文件、没写文字的消息也算有内容
  const hasContent = history.some((m) => String(m.content ?? "").trim() || (Array.isArray(m.files) && m.files.length));
  if (!model) { sse(res, "error", { message: "没有选模型：在输入框右下角挑一个" }); res.end(); return; }
  if (!history.length || !hasContent) { sse(res, "error", { message: "没有内容可发送" }); res.end(); return; }

  const messages = history.map((m) => ({ role: m.role, content: toGatewayContent(m) }));

  sse(res, "start", { model, tools: [], gateway: gatewayURL() });

  let usageTotal = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  try {
    const payload = { model, messages };
    const upstream = await chatCompletions(payload, { signal: abort.signal });
    if (!upstream.ok || !upstream.body) {
      const text = upstream.body ? (await upstream.text()).slice(0, 600) : "";
      sse(res, "error", { message: `magpie ${upstream.status}${text ? " · " + text : ""}` });
      res.end();
      return;
    }

    for await (const chunk of sseChunks(upstream)) {
      if (chunk?.usage) {
        usageTotal = {
          prompt_tokens: usageTotal.prompt_tokens + (chunk.usage.prompt_tokens || 0),
          completion_tokens: usageTotal.completion_tokens + (chunk.usage.completion_tokens || 0),
          total_tokens: usageTotal.total_tokens + (chunk.usage.total_tokens || 0),
        };
      }
      const d = chunk?.choices?.[0]?.delta;
      if (!d) continue;
      if (d.reasoning_content) sse(res, "reasoning", { text: d.reasoning_content });
      if (d.content) sse(res, "delta", { text: d.content });
    }

    sse(res, "usage", usageTotal);
    sse(res, "done", { ms: Date.now() - started });
    res.end();
  } catch (err) {
    if (abort.signal.aborted) { sse(res, "done", { ms: Date.now() - started, stopped: true }); }
    else sse(res, "error", { message: String(err?.message || err) });
    res.end();
  } finally {
    if (clientId) controllers.delete(clientId);
  }
}

// 下拉框的清单 = 网关 /v1/models：那里面已经是"在供应商设置里勾选过、且供应商在线"的模型，
// 所有供应商都在里面，不只是 index-translate。网关没起才退回本插件的静态表，
// 否则下拉框空着、连模型都选不了（页头会同时报网关的错）。
export function staticModels() {
  return MODELS.map((m) => ({
    id: `${PROVIDER}/${m.id}`,
    name: m.name,
    provider: PROVIDER,
    owner: PROVIDER,
    context: m.context,
    output: m.output,
    images: m.image,
    image: m.image,
    note: m.note,
    efforts: [],
  }));
}

// 翻译页这次要动哪几个键：只认 PAGE_KEYS 里出现过的，别的键（base、以后新加的）
// 一概不碰，也不许从这条路由写进来 —— 那些归 magpie 的插件选项编辑器。
// 值统一成字符串（空串就存空串，表示清空）；null 才删键，页面不会发 null。
export function optionsPatch(input) {
  const o = input && typeof input === "object" ? input : {};
  const patch = {};
  for (const key of PAGE_KEYS) {
    if (!(key in o)) continue;
    const value = o[key];
    patch[key] = value === null ? null : String(value ?? "").trim();
  }
  return patch;
}

export async function startServer({ configDir: dirArg, self, options = {} } = {}) {
  const dir = dirArg || configDir();
  const store = createStore(dir);
  const controllers = new Map();
  const port = Number(options.port || 3919);
  const token = await pageToken(dir);
  OWN = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

  // 译入语/术语表/附加要求仍在 plugins.json 里：rewrite() 每个请求读一次，保存即生效
  const translateOptions = () => {
    try {
      return readOptions(pluginsFile(), self) ?? {};
    } catch {
      return {};
    }
  };

  // 清单就是网关 /v1/models；网关没起才退回静态表
  async function list() {
    try {
      return await listModels(options);
    } catch {
      return staticModels();
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1:" + port);
    const path = url.pathname;
    if (!originAllowed(req)) return send(res, 403, { error: "只服务于 magpie 窗口里的翻译页" });
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders(req));
      return res.end();
    }

    try {
      if (path.startsWith("/api/")) {
        if (req.headers[TOKEN_HEADER] !== token) return send(res, 403, { error: "口令不对：这一页连的是上一次的服务，正在自动接上" });

        if (req.method === "GET" && path === "/api/bootstrap") {
          const settings = await store.settings();
          await resolveGateway(options).catch(() => "");
          let gatewayError = "";
          let models = [];
          try {
            models = await listModels(options);
            if (!models.length) gatewayError = "网关里一个模型都没勾选：去供应商设置里勾上";
          } catch (err) {
            gatewayError = String(err?.message || err);
            models = staticModels();
          }
          if (!settings.model || !models.some((m) => m.id === settings.model)) {
            // 默认挑本供应商的：别的供应商没有翻译指令，只当聊天
            const preferred = models.find((m) => m.provider === PROVIDER) ?? models[0];
            settings.model = preferred?.id || "";
          }
          return send(res, 200, {
            port,
            version: VERSION,
            gateway: gatewayURL(options),
            settings,
            models,
            // [fork] 上游这里还回 library（指令/技能/MCP 清单），页面再画成三段设置。
            // 翻译不吃这些东西，那几段设置和 /api/library、/api/mcp/tools 一起删了。
            error: gatewayError,
          });
        }

        // 供应商图标：模型名字前面那个小图标。只有首字母徽章，取图标文件那段没拷。
        const iconHit = /^\/api\/icon\/([^/]+)$/.exec(path);
        if (iconHit && req.method === "GET") {
          const pid = decodeURIComponent(iconHit[1]);
          res.writeHead(200, {
            "content-type": "image/svg+xml",
            "cache-control": "public, max-age=86400",
            "access-control-allow-origin": "*",
          });
          return res.end(letterIcon(pid));
        }

        if (path === "/api/ping" && req.method === "GET") {
          return send(res, 200, { ok: true, port, version: VERSION });
        }

        // 字体：直接读 magpie 设置里的 uiFont / codeFont，生成一份 CSS 给页面用。
        if (path === "/api/fonts.css" && req.method === "GET") {
          const css = await fontCss();
          res.writeHead(200, {
            "content-type": "text/css; charset=utf-8",
            "cache-control": "no-store",
            "access-control-allow-origin": "*",
          });
          return res.end(css);
        }

        if (path === "/api/upload" && req.method === "POST") {
          const body = await readBody(req);
          const name = String(body.name || "file").slice(0, 200);
          const type = String(body.type || "");
          const data = String(body.data || "");
          if (!data) return send(res, 400, { error: "没有内容" });
          // 图片保留 data URL 直接给模型；文本文件转成文本附件
          const isImage = /^image\//.test(type);
          if (isImage && data.length > 24 * 1024 * 1024) return send(res, 413, { error: "图片太大（上限约 24MB）" });
          if (!isImage && data.length > 8 * 1024 * 1024) return send(res, 413, { error: "文件太大（上限约 8MB）" });
          return send(res, 200, { name, type, kind: isImage ? "image" : "file", size: data.length, data });
        }
        if (path === "/api/settings" && req.method === "GET") return send(res, 200, await store.settings());
        if (path === "/api/settings" && req.method === "POST") {
          const patch = await readBody(req);
          return send(res, 200, await store.saveSettings(patch));
        }
        if (path === "/api/translate/options" && req.method === "GET") {
          return send(res, 200, { options: translateOptions() });
        }
        if (path === "/api/translate/options" && req.method === "POST") {
          const body = await readBody(req);
          let saved;
          try {
            saved = patchOptions(pluginsFile(), self, optionsPatch(body?.options));
          } catch (err) {
            return send(res, 400, { error: String(err?.message || err) });
          }
          return send(res, 200, { options: saved });
        }
        // [fork] 上游的 /api/library、/api/mcp/tools 两个空壳路由删了：翻译页没有
        // 指令/技能/MCP 那几段设置，也没有任何地方请求它们。
        if (path === "/api/models" && req.method === "GET") return send(res, 200, { models: await list() });
        if (path === "/api/conversations" && req.method === "GET") return send(res, 200, { items: await store.listConversations() });
        if (path === "/api/conversations" && req.method === "POST") {
          const body = await readBody(req);
          return send(res, 200, await store.saveConversation(body || {}));
        }
        const conv = /^\/api\/conversations\/([\w-]+)$/.exec(path);
        if (conv && req.method === "GET") {
          const c = await store.getConversation(conv[1]);
          return c ? send(res, 200, c) : send(res, 404, { error: "没有这个对话" });
        }
        if (conv && req.method === "DELETE") {
          await store.removeConversation(conv[1]);
          return send(res, 200, { ok: true });
        }
        // 只改标题：/api/conversations 的 POST 会整份覆盖（messages 也会被清空），
        // 所以重命名单独走 PATCH。
        if (conv && req.method === "PATCH") {
          const body = await readBody(req);
          const c = await store.getConversation(conv[1]);
          if (!c) return send(res, 404, { error: "没有这个对话" });
          const title = String(body.title || "").trim().replace(/\s+/g, " ").slice(0, 90);
          if (!title) return send(res, 400, { error: "标题不能为空" });
          c.title = title;
          c.updated = Date.now();
          await writeFile(store.convPath(conv[1]), JSON.stringify(c));
          return send(res, 200, { id: c.id, title: c.title, updated: c.updated });
        }
        if (path === "/api/chat" && req.method === "POST") {
          const body = await readBody(req);
          const settings = await store.settings();
          sseHead(res);
          await runChat({ res, body, settings }, controllers);
          return;
        }
        if (path === "/api/chat/stop" && req.method === "POST") {
          const body = await readBody(req).catch(() => ({}));
          const c = controllers.get(String(body.clientId || ""));
          if (c) c.abort();
          return send(res, 200, { ok: Boolean(c) });
        }
        return send(res, 404, { error: "没有这个接口：" + path });
      }

      // 静态：我们自己的两个脚本
      const extra = EXTRA_STATIC[path];
      if (extra) {
        const data = await readFile(extra).catch(() => null);
        if (!data) return send(res, 404, "没有这个文件", "text/plain; charset=utf-8");
        return send(res, 200, data, MIME[".js"]);
      }

      // 静态：对话页自己的文件
      const rel = normalize(decodeURIComponent(path)).replace(/^([/\\.]+)/, "");
      const file = join(UI_ROOT, rel === "" ? "index.html" : rel);
      if (!file.startsWith(UI_ROOT)) return send(res, 403, { error: "forbidden" });
      let data = await readFile(file).catch(() => null);
      if (!data) return send(res, 404, "没有这个文件", "text/plain; charset=utf-8");
      if (file.endsWith(".html")) data = Buffer.from(data.toString("utf8").replaceAll(TOKEN_SLOT, token), "utf8");
      return send(res, 200, data, MIME[extname(file).toLowerCase()] || "application/octet-stream");
    } catch (err) {
      if (res.headersSent) { try { res.end(); } catch { /* 已结束 */ } return; }
      return send(res, 500, { error: String(err?.message || err) });
    }
  });

  const bindOn = (p) => new Promise((resolve, reject) => {
    const onError = (err) => { server.removeListener("listening", onListening); reject(err); };
    const onListening = () => { server.removeListener("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(p, "127.0.0.1");
  });

  // 端口固定：带路页写死了跳这个端口（页面 CSP 是 connect-src 'none'，没法先探测再决定跳哪）。
  // 被上一次的宿主占着就等它松手，最多等 6 秒；等不到就报错，让宿主日志说清楚。
  let bound = false;
  for (let i = 0; i < 12 && !bound; i++) {
    try {
      await bindOn(port);
      bound = true;
    } catch (err) {
      if (err?.code !== "EADDRINUSE") throw err;
      if (i === 0) console.log(`[index-translate] ${port} 被上一次的宿主占着，等一下再绑`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!bound) throw new Error(`${port} 一直被占用，页面服务起不来`);

  return { port, server, store, close: async () => server.close() };
}
