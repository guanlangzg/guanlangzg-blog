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
- 已知限制：`/media/*`（`src/app/media/[...path]/route.ts`）仍要求 `ensureEditorSession`，正文引用 `/media/...` 的图片对匿名读者 401；公开页读工作副本而非封存产物。
- 2026-10-03 已部署到 VPS（`/opt/guanlangzg-blog`，容器 `blog-navigation`，镜像 `ghcr.io/guanlangzg/guanlangzg-blog:sha-91d7b55…`，摘要 `sha256:29b3b3d942116399fb257159ad2c02ae8f5f82c53bd84ef195310101a241434c`）：公网 `http://114.55.25.190:5678/` 匿名 200 并返回完整博客 HTML，`/blog`、`/navigation`、`/posts/*`、`/feed.xml`、`/sitemap.xml`、`/robots.txt`、`/og` 均 200，`/editor` 307 跳 `/editor/login`，`/media/*` 401。
- 部署关键点：ghcr.io blob 直连被限速到约 1.58MB/min（服务器整体出网 4MB/s），改用 `ghcr.nju.edu.cn` 镜像站（44 秒拉完）并用 ghcr.io 权威 `docker-content-digest` 校验一致后 `docker tag` 成 ghcr 引用部署；重建后仍会因 `.runtime-instance.lock` 属旧容器 hostname 报 500，须核实 mtime 超 90s stale 阈值后 `docker restart blog-navigation` 回收。详见服务器目录 `memory.md`。
- 本机 `npm run start`（standalone）在本机直接崩溃（exit 3221226505），改用 `npx next dev` 完成端到端验证；standalone 启动问题未排查。
- 排查 Next.js VPS 公开页“HTTP 200 但浏览器空白”时，检查响应 `Content-Security-Policy` nonce 是否等于 HTML 中 Next 内联 RSC/流式 `<script nonce>`。若 HTML 有 `x-nextjs-prerender: 1`、`x-nextjs-cache: HIT/STALE` 且 nonce 不同，缓存 HTML 与每请求 nonce CSP 不兼容，React 服务端内容会留在隐藏模板，页面看似空白；抽样 `/`、`/blog`、`/navigation`、`/posts/*` 确认是否为全公开阅读路由故障。修复应让动态 nonce 响应绕过 Next 页面缓存，或对缓存响应使用与已缓存 HTML 一致的 CSP 策略；不可仅以 200、HTML 大小或脚本资源请求成功作为页面可用证明。
- 修复实践：对设置动态 CSP nonce 的 Next 公开阅读页使用 `dynamic = 'force-dynamic'`，包括首页、归档、导航和文章详情；文章详情同时移除 `generateStaticParams`，否则 Next 仍会将已知 slug 预渲染成静态 HTML。生产 `next build` 路由摘要应将这些路由标记为 `ƒ`，prerender manifest 不应含文章详情项。`npm run smoke:public` 可在文档响应层验证没有 `s-maxage`/Next prerender cache，逐个核对内联可执行脚本由 CSP nonce/hash 授权，并继续验证可见标题、交互和浏览器错误；首页 smoke 文案应跟 `src/lib/site-settings.ts` 默认值一致。
- 2026-10-03 修复提交 `74a9b8cd116c6c0667b5275be5487b3a7731a935` 已推送至 `fix/public-csp-nonce-dynamic`（未推 `memory.md`、未改 `main`）。GitHub Actions run `37103810500` 的 check 与 image jobs 均成功：117 个 Vitest 文件、920 项通过，lint、typecheck、deadcode 通过；GHCR 镜像 `sha-74a9b8cd116c6c0667b5275be5487b3a7731a935` 摘要为 `sha256:a82128bbac75b8871808a642e816c872504df88c62df0ff541212bb4c35455a8`。服务器端重复执行 Docker build 因官方 Alpine 源慢约 30 分钟停在 apk，后切阿里云源后已停止尝试；此后 SSH banner 与公网 `/api/health`、`/` 请求均超时，无法确认候选构建是否完全退出或线上容器当前状态，故本次**没有切换生产镜像**。恢复部署前先只读核验远端容器/进程/Compose/租约，确认后再按既有 `docker-update.sh` 流程部署上述 GHCR 镜像；若重建后租约仍旧，按 90 秒 stale 规则核实 hostname 与 mtime 后由应用安全回收，禁止直接删除锁。服务器运维目录的 `memory.md` 尚未更新，因为 SSH 不可达。

## 环境备忘

- 本会话并行派发子代理审查时，同时 5 个会有 3 个报 `user concurrency limit exceeded`，2-3 个并发可稳定运行；重试即可补齐。

## 本机检查命令与工作流沙箱（2026-10-05）

- **静态检查可直接跑，不必经 npm 脚本**（本机 `npm run check` 含 5 项：check:env、lint、typecheck、test:run、deadcode；本机实测全部退出码 0）：
  - `node scripts/test/check-env-files.mjs`（依赖 git 索引）
  - `node ./node_modules/eslint/bin/eslint.js src tests eslint.config.mjs next.config.mjs postcss.config.mjs tailwind.config.ts`
  - `node ./node_modules/typescript/bin/tsc --noEmit --incremental false --pretty false`
  - `node ./node_modules/knip/bin/knip.js`
  - `node ./node_modules/vitest/vitest.mjs run --maxWorkers=2`
- **CI 还有第 6 项检查不在 `npm run check` 里**：`python -m unittest discover -s scripts/test -p "test_*.py"`（本机 Python 3.11.9，11 项通过，约 2 秒）。`npm run check` 通过 **不代表** CI 会过。
- **全量 Vitest 实测约 439 秒、输出约 84KB**（117 文件 / 920 项通过）。84KB 远低于动态工作流 `world.run` 的每流 256KB 拒绝阈值，可安全在 `world.run` 里执行。
- **动态工作流（CreateWorkflow）在本机的两个硬限制**：
  - `world.run` **无法 spawn `npm`**（`npm.cmd` 在 cmd 解析下 ENOENT，直接命令名与 `npm.cmd` 都失败）；改用上面的 `node <node_modules 内 CLI 路径>` 直连形式。
  - `Date.now()` 与 `Math.random()` 在工作流脚本里被编译期禁用，脚本内无法自行计时。
- **工作流 amend 的缓存代价（本机实测结论）**：脚本里只要有 `world.run` 真实执行过且子代理读过文件，amend 后这些 ask 会全部重跑 —— 一次开了静态检查的 15 维度审查，跑 17 分钟、约 735 万 token 后 amend，等于把这 17 分钟全部重付，新运行还要再跑约 42 分钟。**不要在长运行中途为"调整阶段顺序"做 amend**；顺序问题留到下一次新提交或运行结束后处理。
- **长测试排期结论**：全量 Vitest 本就该放在审查/开发流程之后，作为最后的确定性确认；报告与发现应逐条 `report()` 实时上报，使长测试失败或超时也不会丢失已完成的审查结果。
- **工作流脚本设计缺陷（本次已犯，勿再犯）**：复核结果的 `verdict: confirmed | refuted | unclear` 三值若在映射 `status` 时把 `refuted` 与 `unclear` 合并成同一个 `unconfirmed`，报告会把"被证伪"和"判不了"混为一谈，读者无法区分。**三值应映射成三个不同标签**（例如 verified / refuted / unclear），或至少在输出文本里保留原始 verdict 字样。
- **审查报告归档约定**：`docs/` 现有分类为 `开发/`（产品与实施文档）与 `superpowers/plans/`（实施计划）。代码审查报告属独立类别，放入 `docs/审查/`，文件名 `<日期>-<主题>.md`（本机已建 `docs/审查/2026-10-05-全项目多维度代码审查报告.md`）。工作流 `artifact.markdown` 只发到仓库外的 ZCode artifacts 存储，**不会落进仓库**；需要留在仓库的产物必须显式复制进 `docs/`。

## 日期解析与静态产物日期契约（2026-10-06）

- 动 RSS/sitemap 日期逻辑前注意 Node（本机 v24.12.0）`Date` 解析的两处宽松行为，不能用 `Date.parse`/`Number.isNaN` 当合法性判据：① 非日期-only 字符串按本地时区解释——`new Date('2026-09-30 12:00:00')` 在 `TZ=UTC` 得 `2026-09-30T12:00:00.000Z`，在 `TZ=America/Los_Angeles` 得 `2026-09-30T19:00:00.000Z`；② 形似 ISO 但日历无效的值被静默归一且不抛错——`new Date('2026-02-31T00:00:00Z').toUTCString()` 为 `Tue, 03 Mar 2026 00:00:00 GMT`。
- 复现探针（本轮实测）：`node -e 'for (const tz of ["UTC","America/Los_Angeles"]) { process.env.TZ = tz; console.log(tz, new Date("2026-09-30 12:00:00").toISOString(), new Date("2026-02-31T00:00:00Z").toUTCString()); }'`
- 相关现状（本轮只读核对）：`src/public-site/app/sitemap.ts:13` 把 `post.date` 原样作为 `lastModified`（Next metadata 序列化不校验日历有效性）；`src/app/feed.xml/route.ts:22-30` 在解析失败时用 `new Date()` 当前时间兜底，该兜底对静态导出不确定、不可复用。RSS 与 sitemap 若要做日期兼容，应共用同一套严格日历校验并明确固定时区约定。

## 2026-10-06 公开构建 CLI 与容器/死代码门禁（本轮实测）

- 公开站构建 CLI 已强制候选/快照摘要绑定：`--snapshot`、`--out` 之外必须成对给出 `--candidate-digest` 与 `--snapshot-digest`（64 位十六进制），`--identity` 可省，缺省取快照同目录的 `candidate-identity.json`；未知/重复参数、缺值、路径含 `..` 都直接报错（`scripts/public-site/build.mjs:21-52`）。本机实测旧的两参数调用退出 1 并提示 `Candidate and frozen snapshot digests are required for a public build.`——本文件前面记录的 `--snapshot/--out` 两参数写法已失效。
- 容器验收脚本 `scripts/test/verify-builder-container.mjs` 用 `RUNNER_IMAGE`（兼容 `BUILDER_IMAGE`）指定镜像、`RUNNER_SKIP_BUILD=1` 表示复用已加载镜像；无 Docker 时退出码 2 且明确"未验证"，不得当作通过（本机实测退出 2）。它自建一次性夹具（OS 临时目录的快照 + `candidate-identity.json`），不读写仓库内冻结夹具，并在容器内以非 root 断言产物含 `index.html`、`llms.txt`、`manifest.webmanifest`。
- `.github/workflows/ci.yml` 现由 PR 与 push 都触发：check → 只读的 `runner-image`（buildx `load: true` 构建后设置 `RUNNER_IMAGE`/`RUNNER_SKIP_BUILD=1` 跑上面的脚本）；只有非 PR 的 `publish-image` 推送镜像，`packages: write` 只授予该作业。
- `knip.jsonc` 有意保持 exports/types 规则关闭：本机实测 `node ./node_modules/knip/bin/knip.js --no-progress --exports --reporter compact` 退出 1，报告 25 项 unused exports 与 22 项 unused exported types（都在 `src/lib`）。开启该门禁必须与清理这些导出同批进行，否则 `npm run deadcode` 及 CI check 会直接失败。

## 2026-10-06 首版发布验收链修复（本轮实测）

- `npm run test:release` 现在每次用 `os.tmpdir()` + `mkdtemp` 新建独立夹具，只删除自己创建的目录；仓库内 `.tmp/first-release-fixture` 仅由单独的 `npm run test:release:fixture` CLI 维护（仍要求 `.fixture-marker.json` 的 marker），因此可以直接运行 `test:release` 而不会再覆盖既有夹具。
- 夹具按**真实字节**写出 `candidate-identity.json`（`schemaVersion: 1`、`releaseId`、候选摘要、冻结快照摘要）；主构建与变异构建都必须显式传 `--identity` 和两个摘要，变异构建使用独立身份文件，并且要在真实构建成功之后才判断泄漏标记——否则会把"构建被拒"误报成"检出泄漏"。
- 静态 `404.html` 回归：`scripts/public-site/build.mjs` 的隔离构建白名单必须包含 `src/public-site/app/not-found.tsx`，否则 Pages 上未知路径会退回 Next 默认 404；验收已加"`404.html` 必须是共享移除页"的断言。
- CI 的只读 `runner-image` 作业现在在构建镜像前先跑 `npm run test:release`（此前 CI 不执行该验收，全绿也会掩盖其失败）。
- 本机实测 `node scripts/test/verify-first-release.mjs` **26/26 通过，exit 0**；同一轮前后对既有夹具做内容指纹比对，确认字节未变。
- 本仓库 React 为 18.3.1，`require('react').cache` 实测为 `undefined`（`cache` 是 React 19 才有的导出），公开读取的请求级一致性不能直接用 `React.cache` 实现。`src/lib/live-public-reader.ts` 的 2 秒复用窗口是刻意设计：跨请求最多 2 秒旧 release 仍可见，慢请求跨过窗口边界时理论上仍可能混版本。

## 2026-10-06 审查修复轮验收与三个新修 bug（本轮实测）

- **本轮改动规模**：`fix/review-2026-10-05-optimization` 相对 `main`（`efc9e0a`）有 90 个已跟踪文件改动（+5250/−738）与 14 个新文件，全部未提交时的工作树。运行方式：`node ./node_modules/vitest/vitest.mjs run --maxWorkers=2`（约 430 秒）；`npm run check` 的五项与 CI 第六项（`python -m unittest discover -s scripts/test -p "test_*.py"`，11 项）分别验证，`npm run check` 不代表 CI 会过。
- **2026-10-05 审查报告的四条发布/备份断点，经复核均已真实修复**（非掩盖）：候选摘要在发布侧用 `computeCandidateDigest`、构建侧对冻结字节算 sha256，两者**本就不应相等**，改为用不透明身份文件 `candidate-identity.json` + 两个摘要参数各自绑定与自校验；`withdraw` 的 `/posts/<slug>/` 与快照校验只收 `/blog/<slug>/` 的冲突改为两侧都接受两种前缀，并在 `snapshot.ts` 新增 `resolvePathOwnership` 解决同路径双主；runner 阶段补齐 38 条源码闭包 COPY（含 `manifest.ts`、`llms.txt/route.ts`），容器验收脚本改为 `--target runner` 并接入 CI；GitHub 递归 tree 的目录项在 `src/lib/github/backup.ts:407` 按 `entry.type !== 'blob'` 跳过。
- **本轮新修三个真实缺陷**（每个都先用临时回退证明"去掉修复则测试变红"，再恢复）：
  - `NewArticleContent.tsx`：`createdArticleRef` 按 `draftKey` 记忆本次 URL 已建文章，但保存后路由只是 query 变化（`?edit=<id>`），组件实例不卸载、ref 不清除；浏览器后退回 `/editor/blog/new` 再保存第二篇会**整体覆盖已保存的第一篇**。修法：`useEffect(..., [articleKey])` 在路由键变化时清空 ref。
  - `src/lib/publishing/service.ts:172`：`error.replace(/[\\r\\n]+/g, ' ')` 双重转义，实测把 `'Error: cannot resolve module'` 变成 `'E o : ca ot  esolve module'`（删除所有字母 r/n 与反斜杠，真实换行反而保留），构建失败原因写入 release 前已被破坏。修法：改用 `/[\r\n]+/g`。（仓库其余 `[\r\n]` 正则如 `github/client.ts:128` 写法正确，仅此一处出错。）
  - `src/lib/markdown.ts` 的 `getLivePostFromSnapshot` 只按 `decoded[0]` 匹配且不检查段数，live 运行时下 `/posts/a/b` 会渲染 slug 为 `a` 的文章而非 404；非 live 路径（`getRuntimePostBySlugArray`）本就要求 `length === 1`。修法：同样加 `decoded.length !== 1` 提前返回 null。
- **新增测试（回退修复即红）**：`tests/app/new-article-content.test.tsx` 的 `creates a new article when the editor returns to the blank new-article route`；`tests/lib/release-confirmation.test.ts` 的 `keeps the build failure message intact when collapsing line breaks`；`tests/lib/markdown-runtime.test.ts` 的 `does not serve a live article under a multi-segment slug URL`。
- **`BackupStateInvalidError` 补 HTTP 映射**：本轮新增的 `assertBackupStateWritableUnderLock`（`src/lib/editor-data-storage.ts:983`/`:1370`）会在水位或任一 job 文件损坏时拒绝所有内容写入，但该错误此前无任何路由映射，编辑端会得到不可解释的 500。已加 `createEditorBackupStateInvalidResponse`（`src/lib/editor-api-auth.ts`，503 + `code: 'backup_state_invalid'`）并接入 articles/navigation/settings/backup/backup-current-manifest/media-gc 六处 catch，同时接入中央映射 `src/lib/editor-api-errors.ts`；回归测试见 `tests/app/editor-data-routes.test.ts` 的 `returns a structured 503 when backup bookkeeping is damaged`（临时禁用映射分支可复现该用例转红）。
- **本轮确认为"有意保留"而非缺陷的项目**（勿再当 bug 报）：`deferClaimedJob` 把 `attempt` 归零是等待型轮询语义，已被 `tests/lib/jobs-store.test.ts` 的用例正面钉住；`knip.jsonc` 保持 exports/types 关闭是记录在案的欠账（开启须与清理 25 exports + 22 types 同批）。
- **本轮未覆盖**：Docker 容器内公开构建（本机无 Docker CLI，现由 CI 只读 `runner-image` 作业执行）、真实 GitHub/Pages/R2 链路、浏览器端 smoke；`/api/health` 与 Docker/回滚判据仍不看 jobs 健康（本轮只让 `/api/ready` 在持久化文件损坏时降级 503）。

