# SEO 改造计划（对标 codex-resets.com）

## 目标
把 `antigravity-resets.com` 从「JS 空壳 + 122 词」改造成 codex-resets.com 式的
「服务端渲染 + 多语言路径 + AI 可读」实现。

## 检查项

### P0 - 服务端渲染（最高杠杆）
- [x] 新增 `src/seo-data.mjs`：数据加载 + 常量 + 转义工具
- [x] 新增 `src/seo-html.mjs`：HTMLRewriter 注入 + 静态壳本地化
- [x] 新增 `src/seo-jsonld.mjs`：JSON-LD `@graph`（5 个实体）
- [x] 新增 `src/seo-text.mjs`：Markdown / llms.txt / sitemap / robots
- [x] `src/index.mjs` 加路由：`/`、语言路径、`.md`、`/llms.txt`、`/sitemap.xml`、`/robots.txt`
- [x] `wrangler.jsonc`：`run_worker_first: ["/*"]`（否则 www 301 不生效）
- [x] `public/index.html`：加 `#historySection` 注入点 + meta 优化

### P1 - 多语言 + AI 发现
- [x] 5 语言路径 `/`、`/zh-CN`、`/zh-TW`、`/ja`、`/ko`
- [x] hreflang 交叉 + x-default（HTML + sitemap）
- [x] `llms.txt` 结构化
- [x] Markdown 镜像 `index.md` + 4 语言
- [x] robots.txt 显式声明 AI 爬虫（Worker 生成）
- [x] app.js/i18n.js 支持 SSR 语言（真实 `<a href>` + `__SSR_LANG__`）

### P2 - 性能与细节
- [x] 头像转 WebP（471 KB → 3.1 KB）
- [x] 生成 og-image 1200x630（83 KB JPEG）
- [x] twitter:card → summary_large_image
- [x] sitemap 去掉重定向 URL（`/api/docs` → `/api-docs`）
- [x] favicon 106 KB → 26 KB，apple-touch-icon 74 KB → 20 KB

## 验证结果

| 检查 | 结果 |
|------|------|
| 英文首页 SSR 词数 | 122 → **1270** |
| 中文首页 SSR 词数 | **685**（全中文化，无英文闪现） |
| 韩文首页 SSR 词数 | **1049** |
| JSON-LD | 5 实体解析通过（Organization/WebSite/WebApplication/Dataset/FAQPage） |
| canonical + hreflang | 5 语言 + x-default，逐页正确 |
| SSR 与 API 数据一致 | 17 = 17 ✓ |
| www → apex | 301，保留 path + query ✓ |
| `/index.html`、尾斜杠 | 301 收敛到唯一 URL ✓ |
| `/api/docs` | 301 → `/api-docs`（不再出现在 sitemap） |
| 测试 | 51/51 通过（新增 seo.test.mjs 16 项） |
| wrangler dry-run | 218.43 KiB / gzip 52.21 KiB ✓ |

## 过程中发现并修复的既有 bug
1. `src/index.mjs` 的 www 重定向从未生效——`run_worker_first` 不包含 `/`，Worker 对该路径根本不执行。
2. `public/assets/i18n.js` 韩文月份表 11/12 月误用中文「月」，应为「월」。

## 设计取舍
- **不做 FAQ 富结果的预期**：Google 已于 2026-05-07 对所有站点停用 FAQ 富结果。
  FAQPage schema 仍保留（语义清晰、其他引擎与 AI 系统可用），但不承诺 Google SERP 变化。
- **SSR 注入全部 17 条历史**（客户端默认折叠前 3 条）：SEO 需要完整内容，JS 接管后
  折叠是正常交互；闪烁窗口在单帧内。
- **robots.txt / sitemap.xml 由 Worker 生成**，删除静态副本，避免两处定义漂移。

## Review
代码审查发现并已修复：
1. **HIGH**：静态壳的 `ETag`/`If-None-Match` 会串到动态 SSR 响应上——浏览器重验证会命中未变的
   `index.html` 拿到 304，从而永久复用旧的重置数据。已改为内部 fetch 剥离条件头、响应删除
   `ETag`/`Last-Modified`，仅靠 `max-age=60` 控制缓存。
2. **MEDIUM**：`loadSeoData` 每次多查 online/upcoming 两个无人使用的查询，已移除。
3. **LOW**：`og:locale` 缺地区子标签（改 `en_US`/`ja_JP`/`ko_KR` 等）；`301` 对非 GET 会丢 body
   （改 `308`），并把尾部斜杠规范化提前到 `/api/*` 之前；Markdown/`href` 增加 `safeHttpsUrl`
   与链接语法转义；清理死代码（`ag_resets_locale`、`escapeXml`、过时注释）。
4. **产品反馈**：删除了多余的「Did Antigravity reset today?」独立卡片区块——codex-resets 没有
   这个块，且 FAQ 首问已含实时答案，公告列表也已全量 SSR。
5. **测试覆盖缺口**（review 第 7 条）：HTML 渲染此前完全无自动化测试。已导出
   `buildHeadHtml` / `renderFaqHtml` / `renderAnnouncementsHtml`，新增 `test/seo-render.test.mjs`
   5 项（head 标签不重复、JSON-LD 可解析且不被 `</script>` 突破、FAQ 首项展开、非 https 链接被丢弃）。

## 安全审查修复
1. **退订越权 / CSRF**：`GET /api/v1/unsubscribe?email=victim@x.com` 原本能退订任意邮箱，且响应
   里的 `removed` 会泄露该地址是否订阅。改为 HMAC(email) 签名 token：订阅响应返回
   `unsubscribeUrl`，退订必须携带并恒时比对；未配置 secret 返回 503；响应统一 `{ ok: true }`
   不再泄露存在性。邮件里的退订链接同步签名（`src/x-webhook.mjs`）。
2. **`readJsonBody` 先缓冲后限流**：原实现 `await request.text()` 会把整个 body 读进内存后
   才判断大小。改为先看 `Content-Length`，再流式读取、超限立即 `cancel()`。
3. **Judge prompt injection**：父帖/引用帖文本原本作为普通行拼进 prompt。改为 `<<<PARENT_BEGIN>>>`
   等显式不可信分隔符包裹，并在 Tier-1 与 Tier-2 两处 system instruction 中要求不得执行其中
   指令、结论只能基于官方账号自己的 POST 正文。
4. **未验证订阅（邮件轰炸）**：`confirmed` 字段建表时就有但从未使用。现改为 double opt-in：
   订阅先落 `confirmed = 0` 并发送确认邮件（复用现有 Resend 通道），点击 `/api/v1/confirm`
   后置 1；`listEmailSubscribers` 只返回 `confirmed = 1`；未确认的重复提交无法降级或改写已确认
   记录的语言。`0003_confirm_existing_subscriptions.sql` 把历史订阅标记为已确认（表单一提交
   即视为 opt-in）。没有配置 Resend 时，因为根本发不出信，订阅直接存为已确认。

## SEO / GEO / Agentic 第二轮（2026-11-26）

- [x] 字体自托管（3 个 variable woff2）+ preload，去掉 Google Fonts 阻塞请求
- [x] JetBrains Mono 使用 font-display: optional，消除 banner 字体交换位移
- [x] 每个 guide 页生成自己的 `.md` 镜像，`rel=alternate` 指向自身
- [x] `/api-docs` 重写为完整参考：TOC、参数/字段表、响应示例、错误与限流
- [x] `/api-docs` 补 TechArticle + BreadcrumbList
- [x] `/api/v1/resets` 统计不再被 `limit` 缩小
- [x] 对比度、24px 触控目标、heatmap 去按钮化、aria-label 对齐、邮箱 label
- [x] RFC 9727 `/.well-known/api-catalog` + `service-desc` Link 头
- [x] 首页 footer 增加 guide 链接（按语言指向对应版本）
- [x] `llms.txt` 增加 guide Markdown 链接
- [x] 测试 137/137；线上 Lighthouse Accessibility 90 → 100

## 插件全量审计（2026-11-27）

- [x] 8 个子代理并行：technical / content / schema / visual / SXO / backlinks / google / geo
- [x] Critical：`Yes` 答案在 UTC 日界后仍成立 → 改为显式 UTC 日 + as-of + 首屏渲染
- [x] `Organization.sameAs` 去掉被追踪账号，只保留本站 Telegram
- [x] `/guide` Article 悬空 `#organization` → 每页自带实体定义
- [x] 公告与 hero 时间改用 `<time datetime>`
- [x] `.md` 镜像加 `X-Robots-Tag: noindex`
- [x] 404 返回真实 HTML 页面
- [x] sitemap guide 补 hreflang；新增 /about、/privacy
- [x] Dataset 补 license（GSC 警告）、keywords、variableMeasured
- [x] `/about`、`/privacy` 上线并接入所有 footer
- [x] 移动端表格堆叠、图标 40px、theme-color 跟随主题
- [x] robots.txt Content-Signal（search/ai-input/ai-train = yes）
- [x] 生产 Lighthouse：Accessibility / Best Practices / SEO / Agentic 全 100
- [x] GSC 已能读（Restricted）：首页已收录、canonical 匹配
- [ ] 服务账号升级为 Full 后：提交 sitemap、请求索引、跑 28 天查询
- [ ] guide 扩写至 800 词、首页 FAQ 去重（内容工作）
