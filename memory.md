# 项目经验

## 实施入口与范围

- 先读 `AGENTS.md`、`最终博客项目讨论汇总.md`、`docs/开发/第一版开发文档.md`。讨论汇总记录产品决定；开发文档区分源项目已存在的能力、建议实现和首期/二期验收，不得把计划当完成报告。
- 2026-09-30 文档核查时，当前目录仅有规则、文档和标识资产；源项目在相邻 `blog-nevigation`。执行验证命令前先确认新项目的 `package.json` 和脚本已经迁入，不照抄命令后声称新项目通过。

## 工具链与验证前置条件

- 源项目沿用 npm 锁文件，`.nvmrc` 为 Node 24，`packageManager` 为 npm 11.6.2。优先 `npm ci`，不为合并项目更换框架或包管理器。
- 源项目的 `npm run check` 包含环境文件检查、lint、typecheck、Vitest 和 deadcode，不包含 build；静态产物和最终 Docker runner 内构建还需独立验收。
- `scripts/test/check-env-files.mjs` 调用 `git ls-files`，因此新工作区需初始化 Git 后才能执行该检查。不要因目录尚非 Git 仓库而移除检查。

## 需要持续守住的边界

- 原 `Article.status` 是内容分类，不是 Pages 上线证明；候选快照应由本次选中资源加其余已上线版本构成，页面、搜索、RSS 和分享信息消费同一份快照。
- 原恢复接口是整体替换，不是用户要求的逐项冲突合并；先生成已确认的合并结果，再复用原子恢复事务。
- 原 Docker runner 仅含 standalone 运行产物，不含足够的公开站运行时构建依赖。验证必须在最终镜像里实际生成静态站，不以镜像构建成功代替。
- Pages 根路径产物放到子路径预览会破坏根相对链接；预览需覆盖 HTML、Next 资源、索引和媒体的每请求鉴权，不能只保护入口。
- 源 `public/` 不是全部图片来源，运行时媒体需按公开候选引用清单导出；不能把整个 `data/` 或媒体库复制到公开产物。
- 用户已取消清除 GitHub 仓库历史，不再需要 `delete_repo`。新发布应在读回当前头后正常提交，不能强推或删库。

## 审查后需复用的实施约束（2026-09-30）

- 文档优化不等于实施通过。先在 T01 后验证 G01 的最小静态导出、版本绑定预览与最终 Docker runner，再扩展完整链路，避免最后才发现构建依赖/CSP 问题。
- 任意发布确认同时检查全局 GitHub 备份世代/水位与候选 proof；候选备份不能清除其他新保存的 dirty 内容，旧世代任务不能清恢复后的状态。
- Actions 复跑端点需要 Actions write；用同 run ID 的新 run_attempt 核验，不能继续轮询旧失败 attempt 或另造未知触发提交。App 声明作用于安装仓库，操作 token 再按仓库/权限收窄；未实测不报告真实授权成功。
- 原 middleware 使用动态 nonce 并排除 prefetch 请求；静态预览须用封存脚本哈希且所有内容请求经鉴权。`assetPrefix` 不覆盖页面/RSC/public 文件身份，预览须显式绑定固定 release ID。
- 原文章解析器把多段 slug 压成单段且重建字段白名单；首版明确拒绝分隔符/未知 schema 后再解析，不以自动归一化冒充无损兼容。
- 媒体写入独立登记 GitHub 备份；恢复 staging 装完整媒体并集，未引用资产不自动删除。公开引用闭包只用于 Pages，不能套到完整私有备份和恢复。

## T01 迁移与验证（2026-09-30）

- 新项目迁移源当前工作树时按白名单复制 `src/`、`tests/`、`content/seeds/`、`scripts/` 和必要构建配置；排除 `.git`、`data/`、`.env*`、工具状态及源文档。复制前检查环境示例是否包含非空凭据；示例 token 即使标注为本地用途也不复制。
- 保留新项目现有公开标识资产；迁移后搜索旧 logo 和仓库/镜像引用，并将生产 Compose 镜像设为必填环境变量，避免误拉源项目镜像。
- `tests/architecture/project-boundaries.test.ts` 应将 `BLOG_DATA_ROOT` 指向独立临时目录，并只验证已知运行时 JSON/配置文件不存在；不要假设仓库的忽略 `data/` 目录不存在，因为启动服务会创建运行时租约锁。
- 调用 `startServerStartupTasks()` 的单元测试需为每个用例设置独立临时 `BLOG_DATA_ROOT`，在 teardown 恢复原环境变量并清理该临时目录，避免默认根目录的实例租约锁造成串扰。
- `npm run check:env` 依赖 Git 索引；部署测试只应检查目标现存模板，不应引用按迁移范围省略的源 CI workflow 或个人部署脚本。生产构建需独立运行 `npm run build`；容器验收仍需可用 Docker CLI。

## G01 最小静态导出与预览门槛（2026-09-30）

- 公开站构建入口是 `npm run build:public -- --snapshot <冻结快照.json> --out <产物目录>`。`--out` 必须在项目外，或位于项目内 `.tmp/` 下且至少两级路径；脚本拒绝已存在的输出目录，先写入同级 staging 再原子改名。
- 隔离构建不直接对管理应用切换 `output: 'export'`：脚本在临时目录按显式白名单复制公开入口、共享 UI/Markdown 组件和必要 lib，再生成自己的 `next.config.mjs` 与 tsconfig paths。共享源码若要新增依赖，必须同时更新 `scripts/public-site/build.mjs` 的白名单。
- 白名单按文件枚举，不要改成复制整个 `src/lib`：管理端存储、认证、R2、运行时配置属于私有模块，会进入公开构建闭包。
- `fs.copyFile` 的第三参是数值 mode；要“仅当不存在时创建”必须用 `fsConstants.COPYFILE_EXCL`，传 `{ flag: 'wx' }` 是 `writeFile` 写法，会抛 `TypeError`。
- 封存顺序固定：先算不含 `_release.json` 的产物摘要 → 写 `_release.json` → 再算完整清单并断言 artifactDigest 未变，避免自引用改变摘要。逐页 inline script SHA-256 存入清单，预览 handler 据此下发 CSP，不用动态 nonce。
- 预览鉴权须校验会话授权、请求 release ID、期望 ID、会话 active release 与 URL `previewRelease` 一致，再按清单的路径、大小、SHA-256 校验后返回；HTML 用逐页哈希 CSP，统一 `no-store`。新版预览激活后旧 ID 返回 409。
- 公开页面的 Next 资源必须只用 `/_site/<releaseId>/...` 前缀；预览适配脚本必须由 layout 真实引用，否则封存产物不会进入预览模式。
- 本机没有 Docker CLI；最终 runner 内构建属于未验证项；`npm run test:release` 和 `npm run test:builder:container` 应分别记录，不能互相替代。
- feed、sitemap、robots metadata route 若参与静态导出需 `dynamic = 'force-static'`；重命名/移除旧路径与文章 OG 产物要经隔离构建流程统一纳入 manifest。

## T02 草稿/公开快照隔离（2026-09-30）

- `src/lib/publishing/types.ts` 是发布类型唯一来源；`snapshot.ts` 保持纯函数，`store.ts` 是唯一文件存储边界。基础类型复用 `Article`、`Navigation` 和 `SiteSettings`。
- `createCandidate(base, draft, scope)` 先 `structuredClone` 基线再按 scope 覆盖，绝不能共享引用；测试同时守住输入未变和输出引用独立。
- 旧 `Article.status` 不参与上线判定：live 只读显式 `live.json` 指针。
- 候选摘要排除时间戳/重试等非内容字段，但必须包含受管媒体字节摘要；selectedRevision 由 scope、generation、selectedInputs、media 计算。
- slug 校验必须解码到稳定值再判断：编码斜杠、反斜杠及过度编码路径都要拒绝，中文单段保留原文。
- `SiteSettings.showIntroCard` 是布尔字段且不在旧键列表里；schema 校验需显式并入该键。

## 本机环境陷阱：中文路径下 `fs.rmSync` 静默失效（2026-09-30）

- Windows 10 + Node v24.12.0 下，同步递归 `fs.rmSync` 对含非 ASCII 字符的路径可能不抛错也不删除；测试临时目录统一放 `os.tmpdir()`，避免在仓库中文根目录创建。
- 遇到目录残留先检查目标文件是否真的删除，不要假定清理成功；清理历史残留使用已验证的逐文件/PowerShell 方法，不能误删既有用户文件。

## T03 持久化任务与备份水位（2026-09-30）

- jobs claim、状态写入和内容/媒体水位变更在同一个 runtime root 短锁里完成；worker handler 的网络/构建步骤在 claim 之后，不占锁。
- `workflow/backup-state.json` 是全局门槛；水位推进须以同世代、已验证完整备份的冻结 sequence 更新，并取较大值，避免旧任务回退。
- retry 指数从 attempt=1 对应 base 开始；任务失败保留审计记录，不删除历史任务。
- jobs 测试用独立 `os.tmpdir()` 数据根和字段完整的文章 fixture。
- **启动恢复的封存 artifact hash 必须在 runtime root lock 外执行。** 安全结构是：短锁内回收过期 lease、快照待处理 release/job/pointer 身份并恢复候选 build；锁外对固定 artifact root 调用 `createArtifactManifest` 校验实际字节；再获取短锁，重新读取 release、snapshot、pointer 和 jobs，只有完整 identity 未变且没有等价 active job 才创建恢复 job。不能只验证 `artifacts.json` 声明值，也不能以随机 job ID 避免解决错误 identity。
- `artifacts.json` 通常位于 release 的 `public-artifact/` 根，而清单路径指向其中 `app/out/`；恢复扫描须使用与发布 runtime 相同的 artifact root，legacy release 仅按明确布局兼容读取。
- 恢复 fixtures 每个 release 要使用自己的 manifest artifactDigest，并将该摘要写回对应 ReleaseRecord/live pointer；不能用共享硬编码 digest 覆盖清单。pointer 发布中断测试必须先写真实 digest，再持久化 pointer，否则会把 fixture 错误误判为逻辑回归。

## T08/T09 发布恢复与 Pages 验证（2026-09-30）

- Retry 集成 fake `rerunWorkflow` 必须模拟服务端同 run 创建新 attempt；首次 retry 应断言 POST 一次、attempt 1 → 2，重复请求复用同一 retry job。
- Retry 前 Pages 检查、封存产物树校验及 attempt 查询都在内容锁外；内容锁内仅做候选/基线/proof 与 job claim/persist。通过校验后要重新读取 release 并在短锁内原子 claim `RETRY_PENDING → RETRY_POSTING`，只有 claim 成功者可发 POST。POST 结果未知时只允许同一 run attempt 对账，不得盲目二次 POST。
- Pages 密封产物应核对完整清单及真实字节；提交只映射 `app/out` 到 `site/`，使用已核验 parent 与 `force: false`。
- 完整 live proof 需同一 commit、branch、workflow path、run ID/attempt、指定 deploy job/step 和线上 release marker 全匹配；还须确认配置 marker URL 对应 GitHub API 返回的 Pages site URL，站点身份读取失败保持 pending，URL 错配不写 live。
- 本地验证使用 `tests/integration/pages-runtime.integration.test.ts`、`pages-publish-worker.integration.test.ts`、`retry-runtime.integration.test.ts`、`release-recovery.integration.test.ts` 和 `tests/lib/pages-publisher.test.ts`。测试只使用 fake GitHub/HTTP，无真实部署。

## T10 Docker 与升级交付（2026-09-30）

- 本机 Windows 开发环境未安装 Docker CLI，容器/镜像和 runner 内公开构建验收不可执行；纯逻辑测试不能作为容器通过证明。
- Next standalone 管理服务目标根为 `/app/management`。生产 runner 需要完整锁定依赖和隔离构建脚本明确枚举的源码闭包，不复制整个 `src/lib` 或后台组件目录。
- `scripts/public-site/build.mjs` 读取 `BLOG_BUILD_ROOT`（存在时使用该目录，否则回退项目根）；production runner 的 `data/secrets/build` 和 `.next/cache` 权限需在最终镜像中分别验证。
- Docker runner `admin:init` 使用隐藏 TTY 输入和共用密码校验 API；非 TTY 应拒绝且不读重定向 stdin。
- entrypoint 只修正挂载根 owner，不递归 chown 数据；data/secrets/build 三根不可合并；升级仅维护本地前一镜像 tag，不操作数据或 `.env`。

## S4 备份/历史/恢复 UI 边界（2026-10-01）

- Vitest 只收录 `tests/**/*.test.{ts,tsx}`，路由测试应放在 `tests/app/` 并用 tsconfig alias 引入。
- backups UI 消费真实远端 commit DTO；远端 unavailable 时不能把本地 proof 假装成可恢复远端备份，也不能留下旧缓存列表。
- 恢复计划创建/应用当前为同步请求：返回 HTTP 200 真实 `{ planId, conflictCount }` 和 `{ generation }`，不伪装成 202 job；应用逐项传入冲突选择和绑定的 `baseRevision`。
- 文章历史恢复只生成新草稿，不触发 publish。文章列表上的状态按钮只改编辑分类，应明确不代表 Pages live。
- Publishing API 任务列表必须根据 release 当前 `retryFromAttempt` 挑选精确 retry job；初始任务结束后，不应继续将其状态显示为新的 retry task。

## 最近本地实施验证（2026-10-01）

- `npm run check:env`、`npm run lint`、`npm run typecheck`、`npm run deadcode` 已通过；`npm run build` 通过。`test:release` **19/19**。
- S3/S4 聚焦回归 **13 个文件、123 项通过**；job store recovery **20/20**；retry/release recovery **14/14**。测试用例覆盖 Pages site URL 与 GitHub Pages API 身份匹配、manifest actual bytes、未知 retry POST、runtime lock-free hash 和锁内身份复验。
- 默认并发 `npx vitest run` **113/115 文件、897/899 项通过**，另报告 5 个 Vitest fork worker 启动 timeout；失败的 `tests/lib/markdown-runtime.test.ts` 与 `tests/lib/startup-tasks.test.ts` 单独运行 **17/17 通过**。`npx vitest run --maxWorkers=6 --minWorkers=2` 未能启动（Vitest 4.1 CLI 不支持 `--minWorkers`），全量测试仍需用本版本支持的有限并发参数重跑。
- 管理端 build 的本地公开 URL 没配 `NEXT_PUBLIC_SITE_URL` 时回退 localhost，并提示 sitemap/RSS/canonical 可能指错。部署前必须提供正式公开站 URL。
- Docker、真实 GitHub App/Pages、VPS 与内地网络均未在本轮执行；没有提交、push 或部署。

## 2026-10-02 全库代码审查确认的待修 bug（修复前均为已知限制）

**2026-10-02 更新：以下 🔴 六项已全部修复并通过回归测试**（修复涉及：`api/editor/publishing-revision/route.ts` + `editor-runtime/adapters.ts` 抽出共享 `readDraftResourceRevisions`；`api/data/articles/route.ts` PATCH + `article-data.ts` 新增 `assertUniqueArticleSlugs`（写入侧统一守卫，PATCH/PUT 均调用）+ 路由 400 映射；`api/data/media/gc/route.ts` 包 `withRuntimeDataRootLock`；`request-client.ts` XFF 改为从右向左跳过可信代理；`restoring/apply.ts` 用 `lastIndexOf('](')` 定位目的地址；新增 `src/app/hooks/useTagsText.ts` 供三处标签输入使用，`tool-form.ts` 的 `normalizeTagsInput` 已随之删除）。

- **重要语义变更（限流身份）**：配置非通配 `TRUSTED_PROXY_IPS` 后，单段 XFF 现在被视为可信代理记录的客户端 IP（nginx/express 语义），各客户端独立限流；旧语义是单段 XFF 一律不可信、全体落入 `unknown` 共享桶（导致 5 次失败锁全站）。直连部署却配置了可信代理属操作错误，此时 XFF 可被伪造（与 nginx real_ip 同类权衡）。`tests/app/editor-auth.test.ts` 与 `tests/app/search-route.test.ts` 各有一个测试已按新语义改写。CIDR 网段支持仍缺，Cloudflare 动态出口池场景只能用 `*`（有告警）。
- 审查同时发现 adapters 里 article scope 原本也把整个快照传给了 revision 计算（比代理报告的"仅 bootstrap"多一个 scope）——现有集成测试创建候选时不传 expectedRevision、UI 测试 mock 了 fetch，因此从未暴露；新增的 `tests/app/editor-publishing-revision.test.ts` 端到端钉住四个 scope 的两端一致性。
- 仍开放的 🟡 项（代理核实、未修）：运行时改密不查弱口令黑名单；未认证 setup PUT 无 CSRF/Content-Type 校验；`void drainPendingBackups()` 两处无 catch；恢复读取侧不校验清单哈希；导航合并只采纳每分类第一个冲突选择；`markPreviewFailed` 正则双重转义；jobs 单损坏文件停转 worker、defer attempt 归零退避恒 1s；useTheme hydration 失配；公开站构建白名单漏 `manifest.ts`/`llms.txt`；sitemap 硬编码日期；导航编辑器下标 key；Cmd+S 无重入守卫；`getTodayString` 用 UTC；编辑器读不到嵌套 `error.message`。

原审查结论（修复前记录）：

- **Bootstrap 首次发布 UI 100% 返回 409**：`api/editor/publishing-revision/route.ts` 的 `bootstrap` 返回 articles 单资源 revision，而 `editor-runtime/adapters.ts` 对 bootstrap scope 计算 `createJsonRevision` 三资源组合哈希，`publishing/service.ts` 锁内比对必失败。修复须让路由返回与 adapters 相同的组合 revision。
- **PATCH upsert 不做 slug 查重**：`api/data/articles/route.ts` PATCH 只 parse 单篇，`applyArticlePatchOperations` 只按 id 合并；写入重复 slug 后读取端 `parseArticlesDataOrThrow` 抛错，编辑器与公开页全站 500。
- **媒体 GC 不持数据根锁**：`api/data/media/gc/route.ts` 直接调 `deleteOrphanMediaFiles`；与上传（先写文件后写 manifest）或恢复（目录替换间隙 manifest 为空）并发会误删刚写入/刚恢复的媒体。
- **登录限流身份解析缺陷**：`request-client.ts` 只在 XFF ≥2 段且末段可信时取最左段；单可信代理（最常见）恒为 `unknown` 全局共享桶，5 次失败锁全站；≥2 代理时最左段可伪造绕过。修复方向：取最后可信代理追加的段 + 支持 CIDR。
- **恢复改写器重叠区间损坏正文**：`restoring/apply.ts` `rewriteMarkdownMedia` 对"链接与内层图片 URL 相同"的嵌套结构（常见封面写法）算出同一替换区间，按原始偏移二次拼接会截断新 URL 且外链漏改写。
- **标签输入框键盘无法输入逗号**：受控 `value={tags.join(', ')}` + onChange 立即 split/join 回写，逗号被 React 复位吃掉；`FrontmatterForm.tsx`、`ToolItem.tsx`、`navigation/page.tsx` 三处同模式。
- 其他应修项（代理核实）：运行时改密不查弱口令黑名单；`void drainPendingBackups()` 无 catch 可 unhandled rejection 击穿进程；`markPreviewFailed` 正则 `/[\\r\\n]+/` 双重转义会删除错误消息中的 r/n 字符；jobs 单个损坏文件使 worker 循环永久停转；`deferClaimedJob` attempt 归零退避恒 1s；恢复读取侧不校验清单哈希；useTheme 初始化读 localStorage 致 hydration 失配；公开站构建白名单漏 `manifest.ts` 与 `llms.txt` 路由；导航编辑器下标 key 可致跨条目覆盖保存；新建文章 Cmd+S 无重入守卫；`getTodayString` 用 UTC 日期。

## 2026-10-02 GitHub 构建测试 + hangzhou2-2 首次部署（已完成）

- **部署架构（已验证跑通）**：GitHub Actions 构建/测试镜像并推 ghcr.io → 服务器只拉取运行。CI（`.github/workflows/ci.yml`）：check 任务（npm ci + check:env + lint + typecheck + vitest --maxWorkers=2 + knip）→ image 任务（buildx + GHA 缓存，镜像标签 `ghcr.io/guanlangzg/guanlangzg-blog:<branch>` 和 `sha-<全 sha>`）。ghcr 包随公开仓库自动为 public，服务器可匿名拉取。配套 `lock-sync.yml`（手动调度，linux 上补全 lock）保留在仓库。
- **首次镜像构建踩坑记录（均已修复进仓库）**：① lock 缺 linux 平台可选依赖（@emnapi/core、嵌套 @emnapi/runtime@1.11.2，来自 @oxc-* 的 wasm32-wasi 绑定）——Windows 上 npm 永远不会物化该子树，本机无法修复，用 lock-sync 在 ubuntu 上补全；② Dockerfile runner 阶段 chown 引用未 mkdir 的 `/app/management/public`；③ 公开站隔离构建两个缺陷：快照无 /blog/ 移除路径时 Next 15 导出模式对预渲染 0 条的动态路由误报 missing generateStaticParams（改为按需复制该路由）、构建根在项目树外时 workspace 解析不到依赖（build.mjs 现自动 symlink node_modules）；④ Dockerfile 引用空的 scripts/runtime（git 不跟踪空目录）；⑤ 容器内 sharp 渲染 og 中文需 fontconfig + font-noto-cjk。
- **服务器部署（hangzhou2-2）**：`/opt/guanlangzg-blog`，容器 healthy，公网 `http://114.55.25.190:5678` health/login 均 200，登录令牌端到端验证通过；详见服务器目录 memory.md 2026-10-02 小节。TRUSTED_PROXY_IPS 设为 `*`（直连部署、无代理，无配置时登录端点会按设计 503）。
- **生产环境修改 Compose `.env` 后须重建容器**：`docker restart` 不会更新已创建容器的环境。安全顺序是比较期望配置（只输出哈希/是否匹配）、`docker compose ... up -d --force-recreate app`、核对环境匹配和 health。应用使用数据卷租约 `.runtime-instance.lock`，短时间内重建可能遇到旧容器留下的租约；先确认锁 hostname 与当前容器 ID 不同且 mtime 超过 `runtime-instance-lease.ts` 的 90 秒 stale 阈值，再由一次 restart 触发代码内回收，禁止未核实直接 rm 锁。运行时认证配置优先于 `EDITOR_ACCESS_TOKEN`；若 `editor-auth.json` 存在，应使用已登录网页改密或服务器 `admin:init`，而不要期待环境变量覆盖哈希。
- **Git/环境坑**：本机 git 推 github.com 间歇被重置，用本机 Clash 混合端口（127.0.0.1:7897）做 `HTTPS_PROXY` 推送；repo-local git 身份是 `99485603+guanlangzg@users.noreply.github.com`（gh auth status 显示的"242282218"不是登录名，勿据此拼 noreply 邮箱）。
- 后续待办：浏览器端完成 GitHub App 连接与首次发布（引导页）；验证容器内发布（build.mjs 运行时路径）；dev 合入 main 时 main 上的 ci.yml 会换成完整触发配置。

## 2026-10-02 审查修复轮次（R2/GitHub/口令/公开站）

- **R2 latest 指针并发保护**：`writeLatestPointerConditionally` 读取当前 latest 及 ETag，用 `IfMatch`（已有）或 `IfNoneMatch: '*'`（首次）条件写入；候选 `updatedAt` 小于等于当前指针时跳过，同时间戳用 `snapshotId` 字典序仲裁。测试用 `vi.useFakeTimers()` 控制时间戳，mock S3 对 `IfMatch`/`IfNoneMatch` 冲突返回 412。
- **GitHub 恢复清单校验**：`snapshot.json` 的 `contentDigest` 是 `files` 的稳定 JSON 摘要（不含 `snapshot.json` 自身）；恢复时只读取 manifest 声明的文件，防止未声明 blob 进入恢复数据。测试需 mock `createConfiguredGitHubBackupClient` 并使用真实 40 位 commit SHA（fake 可 addCommitAlias 映射）。
- **公开隔离构建新增 metadata route**：Next 15 `output: 'export'` 要求每个 route 显式 `export const dynamic = 'force-static'`，否则构建报错；`manifest.ts` 和 `llms.txt/route.ts` 均已补上。manifest icon 指向实际随 release 输出的 `favicon-32.png`。
- **口令统一校验**：`isValidEditorSecretShape` 共享长度及禁用词规则；运行时初始化、改密、setup 路由、runtime-config 路由均调用；API 错误文案统一为"编辑口令不符合安全要求。"
- **验证结果**：聚焦回归 70 项通过；全量 Vitest 117 文件 916 项通过；lint、typecheck、deadcode、`git diff --check` 均通过；`test:release` 19/19 通过。

## 2026-10-02 恢复 VPS 公开博客入口（决策变更）

- 症状与根因：`http://114.55.25.190:5678/` 307 跳 `/editor/login?next=%2Feditor`，看起来像"公开展示功能被删"。实为 `src/lib/vps-access-policy.ts` 的 `classifyVpsRequest` 刻意拦截：只有 `/editor/login`、`/setup`、`/api`、`/_next`、品牌图匿名放行，其余公开路径无 `previewRelease` 时一律 blocked。`src/middleware.ts` 文档注释也写明"reader content only exists on GitHub Pages or inside a version-bound preview"。原始动态公开页与页头 `:admin`（`ADMIN_SHORTCUT = ':admin'`，`CommandInput`/`useCommandAdminMenu`）代码一直在，只是被拦。
- 判断"原版设计"的证据：`scripts/test/verify-public-ui.py`（`npm run smoke:public`，默认 `http://127.0.0.1:3210`）验证 `/`、`/blog`、`/posts/2026-05-25-getting-started`、`/navigation` 和页头 `aria-label="搜索文章和链接"`（即 `CommandInput`），说明公开站本就该由应用本体同源提供。
- 改动：`classifyVpsRequest` 在 `previewRelease === null` 时对公开阅读路径返回 `allow`：`/`、`/blog`、`/blog/*`、`/posts/*`、`/navigation`、`/navigation/*`，以及 `/feed.xml`、`/sitemap.xml`、`/robots.txt`、`/og`。带 `previewRelease` 时仍走封存产物预览，管理员预览流程不变。公开页只渲染 `isPublicArticleStatus`（即 `status !== 'draft'`）的文章（`src/lib/markdown.ts` 的 `getRuntimePostsAsync` 已过滤）。
- 同步更新的测试：`tests/app/vps-access-policy.test.ts`、`tests/app/editor-middleware.test.ts`（原 "no longer serves the legacy dynamic reader pages from the VPS" 用例改为断言匿名 200）、`tests/app/preview-routing.test.ts`（原匿名跳登录/401 用例改为 200）。
- 验证方式（本机）：`npm run build` 通过；`npx vitest run --maxWorkers=2` 全量 **117 文件 / 920 项通过**；`npm run lint`、`npm run typecheck` 通过。端到端：`npx next dev --port 3210`（配临时 `BLOG_DATA_ROOT`）后匿名 curl —— `/`、`/blog`、`/navigation`、`/posts/2026-05-25-getting-started`、`/feed.xml`、`/sitemap.xml`、`/robots.txt` 均 200，`/editor`、`/editor/blog` 仍 307 跳登录，`/media/...` 仍 401。
- 已知限制：`/media/*`（`src/app/media/[...path]/route.ts`）仍要求 `ensureEditorSession`，正文引用 `/media/...` 的图片对匿名读者 401；公开页读工作副本而非封存产物。真实 VPS 仍是旧镜像，需重建镜像后 `docker compose ... up -d --force-recreate app` 才生效。
- 本机 `npm run start`（standalone）在本机直接崩溃（exit 3221226505），改用 `npx next dev` 完成端到端验证；standalone 启动问题未排查。

## 环境备忘

- 本会话并行派发子代理审查时，同时 5 个会有 3 个报 `user concurrency limit exceeded`，2-3 个并发可稳定运行；重试即可补齐。
