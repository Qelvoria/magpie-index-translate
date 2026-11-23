# AGENTS.md

给 AI 编程助手和二次开发者的开发文档。[README.md](README.md) 是用户文档；架构、实现细节、坑和取舍看这里。`chat/`、`page/`、`lib/server.mjs` 里相对上游故意改掉的地方源码都标了 `[fork]` 注释，别改回去。

## 结构

```
index.mjs           插件入口：config / auth / provider.models / 起页面服务
lib/translate.mjs   rewrite()：请求改写，插件的主体
lib/prompt.mjs      instTrans 提示词，官方 build_prompt() 的镜像
lib/models.mjs      模型表 + configModels() + 上游 /v1/models 探测
lib/store.mjs       plugins.json 本插件那一项的读写，PAGE_KEYS 的出处
lib/server.mjs      页面背后的本机服务（magpie-chat 的裁剪版）
lib/gateway.mjs     magpie 网关客户端（原样拷自上游）
chat/               对话页：app.js / style.css / index.html / vendor/katex
page/               带路页 boot.js + 沙箱内表单逻辑 options.js / translate.js
bin/cli.mjs         不开 magpie 直接试一句（要 Bun）
bridge/             call_api.py 官方脚本副本 + serve.bat 一键网桥
test/               5 个文件，覆盖提示词、改写、网关、plugins.json、页面表单
```

## 请求链路

页面只发 `{model, messages}` → magpie 网关（默认 `http://127.0.0.1:3425`，探测顺序 `opts.gateway` / `MAGPIE_CHAT_GATEWAY` → `MAGPIE_ADDR` → 默认端口；key 取 `MAGPIE_API_KEY` / `MAGPIE_GATEWAY_KEY`，否则读 `~/.config/magpie/caller-keys.json`）→ 插件 loader 的 `fetch` → `rewrite()` → 上游。

好处：页面和 agent 同一条改写路径，提示词只有 `lib/prompt.mjs` 一份，用量记进 magpie 的 `routing/*.jsonl`。代价：页面必须 magpie 在跑。`bin/cli.mjs` 不走网关，直连上游，只用于验证提示词和连通性。

## rewrite() 做的事

1. **补翻译指令**：只取最后一条用户消息的正文，按官方格式包一层（`请将以下文本翻译为…`）。Index-Translate 是指令微调模型，裸发原文它会当聊天回答。没有可翻译正文（纯工具调用）时原样放行，让上游自己拒。
2. **放行客户端自带的翻译提示词**：system 或最后一条消息命中 `TRANSLATION_TASK_RE` 且长度 ≤ `CLIENT_PROMPT_MAX`(1000) 时整套不动，不再叠加我们的指令——沉浸式翻译那类客户端自己写了"翻译成中文"。只看关键词会把 agent 编程提示里的 "do not translate code" 误判成翻译要求（实测返回闲聊），所以加了这两条判据。
3. **丢 agent 的编程提示 + 上游不认的字段**：`DROP_FIELDS`（tools / tool_choice / functions / response_format / logit_bias / stop / seed）删掉，`n` 强制 1，其余 system 丢弃。
4. **关思维链**：注入 `chat_template_kwargs.enable_thinking=false`，`temperature` 没给就设 0，否则 `<think>` 顶掉译文。非流式响应再过 `cleanResponse()` 把残留的 `<think>` 去掉。

带 `image_url` / `input_image` 片段时改走 `buildImagePrompt()`，正文连同 instruction/glossary 作为附加要求，图片原样转给 35B。

目标语种三级：选项 `target`（非 auto）→ 原文点名（`翻译|translate … 成|为|to` + `LANG_ALIASES`）→ `guessTarget()`（含假名→zh，汉字占优→en，其余→zh）。

## 提示词

`lib/prompt.mjs` 逐字对齐 `bridge/call_api.py::build_prompt()`（约束文案、分隔符、结尾句、JSON 保护后缀），官方改动时要一起更新。唯一例外：给了术语表时多一句「只在源文中出现该术语时按对照翻译，源文没有的不要加进译文」。不加的话术语会被硬塞进无关译文——同语种时 `今天天气真好` 会变成 `今天天气真好，手仕舞（截止日期）快到了。`（实测 35B，`temperature=0`）。

术语表解析与官方同构：JSON 字典和 `a:b` / `a->b` / `a→b` / `a：b` 逗号分隔都认（"文件路径"那一支在插件里没意义，略去）。`instruction` 一行一条，没带【硬性要求/注意/软性要求】前缀的行统一加成【注意】。

除 `base`/`target`/`instruction`/`glossary` 之外的参数一律写死成官方默认（源语种、文体、temperature、思维链、系统提示、max_tokens）。加配置项之前先确认真有需求，每多一个就多一处要解释要测。

## 配置读写

`plugins.json` 里本插件那一项的 `options` 是唯一配置源，插件每个请求 `liveOptions()` 重读一次磁盘 → 页面保存即生效。`readOptions()` 返回 `null` 表示 plugins.json 里根本没有这一项（OpenCode 内联 `["pkg", {…}]` 的装法），此时别拿默认值盖掉内联配置。键缺失 = 从没设过或被编辑器删掉 → 按 `PAGE_DEFAULTS` 重新算，不能沿用加载时那份旧值。

所有权划分：页面只拥有 `target`/`instruction`/`glossary`（`lib/store.mjs` 的 `PAGE_KEYS`），`base` 及以后新增的键归 magpie 的插件选项编辑器。`optionsPatch()` 是路由白名单，页面多带键会被丢掉；值统一成字符串，空串表示"清空过"（编辑器里仍然看得见），只有 `null` 删键。`patchOptions()` 按键合并 + 临时文件改名写入，避免写坏 `plugins.json`。整份替换是历史 bug：页面保存一次就把没画的键抹掉，别再退回去。

沙箱页面 import 不到 `lib/store.mjs`，所以 `page/options.js` 里的 `ITO.KEYS` / `ITO.DEFAULTS` 是手抄的第二份，`test/page.test.mjs` 逐字比对。加选项要同时改四处：`PAGE_KEYS`、`ITO`、`optionsPatch`（跟着 PAGE_KEYS 自动生效）、README 的选项表。

端口不是配置项：magpie 加载时通过 `options.port` 递进来（`package.json` 的 `magpie.page.service.option`），脱离 magpie 单跑才用 `3919` 兜底。`base` 是唯一要重启才生效的选项——供应商 api 地址在 `config` 钩子里就定死了。

## 页面服务与口令闸

插件页面跑在 `sandbox="allow-scripts"`、CSP `connect-src 'none'` 的框架里：fetch、WebSocket、表单全禁，唯一能做的联网动作是把自己导航走。所以 `page/index.html` 只是带路页：`page/boot.js` 读 bridge 的主题令牌 + `magpie.service`（老版本没有才退回 `options.port`），`location.replace` 到本机服务；沙箱那边 origin 是字面量 `"null"`（opaque），服务必须认 `Origin: null` 并回 `Access-Control-Allow-Origin: null`，否则页面全是 "Failed to fetch"。`access-control-allow-methods` 要列全 GET/POST/PATCH/DELETE/OPTIONS，漏掉的方法预检过不去，前端只看到 "Failed to fetch"。

第二道闸是口令（上游只看 Origin，本机任意网页都能造出 `Origin: null`）：口令注入 `chat/index.html` 的 meta，`/api/*` 一律要 `x-it-token`，静态文件不发 CORS 头所以外面读不到。口令存在 `<数据目录>/page-token`（48 位 hex，POSIX 0600）复用，服务重启、插件 off/on、宿主换进程都不变——每次新生成会让 magpie 里还开着的那页揣旧口令全 403，这曾是要手动刷新的 bug。落盘失败退回内存口令。真撞上失配（比如口令文件被删）时 `chat/app.js` 的 `api()` / `streamChat()` 识别报错里的"口令"字样，同源再取一次页面文本换新口令重试一次，不重载页面，输入框里没发出去的内容也不丢。

上游那套为翻译保留的裁剪：去掉 MCP 客户端与工具循环、去掉 library 的指令/技能拼装（连 `/api/library`、`/api/mcp/tools` 和 `settings.json` 里 system/instructions/skills/mcp/temperature/maxTokens/effort 七个没人读的键一起删）、`/api/chat` 请求体只留 `model` + `messages`（温度与关思维链由 `rewrite()` 注入）、数据目录 `magpie-index-translate`、字体从 magpie `settings.json` 的 `uiFont`/`codeFont` 现生成 CSS、供应商图标只留首字母徽章。新增路由前先想清楚翻译页用不用得上。

模型清单：`/api/bootstrap` 与 `/api/models` 用网关 `/v1/models`（所有供应商里勾选过的，不只是本插件），网关没起或返回空才退回 `staticModels()`（`lib/models.mjs` 那张表）——否则网关没跑时下拉框空着连模型都选不了。默认选中本供应商的模型，别的供应商没有翻译指令只会闲聊。`index.mjs` 的 `provider.models` 是另一件事：它问上游要模型列表，用静态表补显示名，失败就保留 magpie 上一份。

## 长回复的流式渲染

上游每收到一点文字就重建整条回复的 DOM，一千多字译文要重建九十多次，CSS 动画每帧从头开始，看着就是整屏闪。`chat/app.js` 的改法：`stableSplit()` 按"最后一个不在代码块里的空行"把正文切成已定稿和在动两段，已定稿只追加一次，只有尾巴反复走 `renderStreaming()`；`pumpTake()` 让打字机每帧字数跟积压量走（原来按总长度算一次，长文退化成每帧 3 个字）；`finish()` 无条件按最终全文渲染一次。滚动：自动跟随只在实际差着距离时才改 `scrollTop`，程序滚的那一下不反过来关掉跟随（`lastAutoScroll` 150ms 内忽略滚动事件），签名不变不重绘。

回归基线，一段 1576 字的流：整段 DOM 重建 91→3、光标节点 91→1、MutationObserver 记录 976→354 条。

## 上游与第三方

底子来自 [magpie-chat](https://github.com/Magiczerowxy/magpie-chat) commit `82f4fd9`（MIT，正文 `chat/LICENSE-magpie-chat.txt`，别删）。它是参照，不是要跟齐的上游：升级时按 commit 重新比对 `[fork]` 差异点，别整份覆盖本地改动，也别把为翻译做的取舍改回去。

`bridge/call_api.py` 是官方 `inference/llm/call_api.py` 原样副本，插件运行时不依赖它：一是给 `lib/prompt.mjs` 当对照，二是 `--serve` 网桥（浏览器插件直连公网要 CORS 头、关思维链、`temperature=0`，这三件事插件自己发请求时已经做了，magpie 场景不需要开网桥）。

本项目 Unlicense（见 `LICENSE` 与 `package.json`），第三方保留各自许可：

| 路径 | 来源 | 许可 |
|---|---|---|
| `chat/app.js`、`chat/style.css`、`chat/index.html`、`lib/gateway.mjs` | magpie-chat @ `82f4fd9`，按翻译场景改过 | MIT |
| `chat/vendor/katex/`（约 600 KB） | KaTeX | MIT，刻意入库（离线渲染、不连 CDN），`.gitattributes` 已把字体标成 binary |
| `bridge/call_api.py` | bilibili/Index-Translate | 随上游仓库 |
| 其余 | 本项目 | Apache-2.0 |

## 开发自检

```bash
node --check index.mjs
for f in lib/*.mjs bin/*.mjs test/*.mjs; do node --check "$f"; done
bun test                                   # 36 个用例
python -m py_compile bridge/call_api.py    # 可选，只有网桥用得到
```

页面服务是运行期集成（要 magpie 在跑），不在仓库自检范围内。

## 改动后怎么生效

- 改 `index.mjs` / `lib/*.mjs`：`magpie plugin off index-translate` 再 `on`，否则跑的还是宿主里缓存的那份模块。
- 改 `lib/server.mjs` / `chat/` / `page/`：**必须重启 magpie**。光 off/on 不够，老宿主进程没退，那一页跳的还是它手里那个端口，看到的仍是旧代码。
- 端口被上一次宿主占着时会重试绑定（12 次 × 500ms），等不到就在日志里报「一直被占用」。
- magpie「路由」页面显示的是送进插件之前的请求，插件的改写和 HTTP 都在它之后，所以那里永远看不到包上的翻译指令。要确认发出去什么，看 `~/.config/magpie/routing/*.jsonl` 的 `prompt.counted` / `prompt.tokens`：原文 4 个中文字却有 30 多个 token 就是指令在里面。

## 已知限制

- 每段翻译都没有上下文（`rewrite()` 只取最后一条用户消息），要做多轮翻译得改取值策略并同步 `test/translate.test.mjs`。
- 想让 magpie 自己「持有」这条指令，只能把改写搬进网关中间件（`onProvider` 里按 `ctx.provider.id` 过滤），body 在路由前就改好，magpie 的上下文窗和计费才按带指令的 prompt 算；插件这条路拿不到自己发出的字节，只能从上游 usage 反推。代价是要自己适配 Claude Messages / Responses / Gemini 三种 body 形状，而且外层跑在 moejs 里（没有 fetch、只有相对 import、250ms 限时）。
