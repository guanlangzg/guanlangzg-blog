# T05 备份与文章历史接线实施计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 完成 T05 的已批准剩余接线：让完整 GitHub 备份 worker 在服务启动时运行，提供受保护的文章历史分页/恢复 API，并在文章列表中可查看历史和恢复为草稿。

**架构：** 保持快照 codec、GitHub REST 边界与历史服务现有职责。只有不包含 candidateReleaseId 且冻结 generation/sequence 与当前工作区匹配的验证全量快照，才可回报 `verifiedFullBackup`；候选 proof 仅持久化到指定 release。启动边界启动可 AbortSignal 停止的 worker，只注册真实实现的 backup handler。文章历史 API 通过私有管理员会话、写请求 CSRF/Origin 与文章 revision 校验，UI 通过现有卡片/状态组件调用 API。

**技术栈：** Next.js 15 Route Handlers、TypeScript strict、React、Vitest、现有 GitHub App token/REST client 和持久化 job worker。

**规格：** `docs/开发/第一版开发文档.md` §6.4–6.6、§7.4、§10.2；用户已批准的 T05 直接实施要求。

## 全局约束

- 不编辑 `src/lib/jobs/**`、`src/lib/publishing/**`、`src/lib/github/{client,app,config,secrets}.ts`、`src/public-site/**`、`src/lib/public-build/**`、`scripts/public-site/**`。
- 不发起真实 GitHub 请求；GitHub 边界只能由注入 fake fetch 验证。
- 不提交、不推送；不触碰 `D:\PROJECT_ZZZZZZZZZ\blog-nevigation`。
- 保持全局水位与候选 proof 为两个独立门槛；文章历史恢复先保护当前草稿，revision 冲突不得覆盖新编辑，也不发布。
- 只运行聚焦 Vitest、lint、typecheck；最后将可复用约束记入 `memory.md`。

---

## 文件职责

- 修改 `src/lib/github/backup-service.ts`：按 job 冻结水位捕获 snapshot；候选 job 持久化 candidate proof 但不推进 global watermark。
- 修改 `tests/lib/github-backup-service.test.ts`：用真实 fake GitHub 客户端证明候选 job 不能认领完整备份水位；验证普通完整任务返回 full-backup proof。
- 修改 `src/lib/startup-tasks.ts`：启动唯一 worker loop、仅注册 backup handler；AbortController 用于测试 reset/显式 shutdown。
- 修改 `tests/lib/startup-tasks.test.ts`：mock worker 和 GitHub client 工厂，验证 startup 单次启动/停止及 handler 接线。
- 创建 `src/app/api/editor/articles/[id]/history/route.ts`：管理员会话下分页读取文章历史，返回 `Cache-Control: no-store`。
- 创建 `src/app/api/editor/articles/[id]/history-restores/route.ts`：校验 CSRF、commit SHA、expected revision，受保护地恢复为草稿并报告冲突。
- 创建 `tests/app/article-history-routes.test.ts`：验证认证、分页输入、恢复 CSRF/revision 冲突/成功及 no-store。
- 修改 `src/app/editor/(authenticated)/blog/components/ArticleCard.tsx`：提供带 aria-label 和 focus ring 的历史入口与分页/恢复反馈。
- 修改 `src/app/editor/(authenticated)/blog/page.tsx`：在卡片级操作中调用受保护历史 API，refresh 本地编辑态或显式报告刷新页面。
- 修改 `tests/app/editor-blog-page.test.tsx`：验证历史入口键盘焦点样式与成功恢复反馈/API 调用。
- 修改 `memory.md`：记录 history API 的鉴权/revision 契约以及 worker shutdown 方式。

## 任务 1：限制水位推进为真实完整快照

- [ ] **步骤 1：构造 fake GitHub service 测试**
  在 `github-backup-service.test.ts` 追加 fake GitHub fetch/client fixture，复用 `tests/lib/github-backup.test.ts` 的 fake REST 端点最小必要集合。断言候选 job 完成时保存 release candidate proof，但返回结果不包含 `{ verifiedFullBackup: true }`；普通 complete-backup job 返回该标志及远端 commit。
- [ ] **步骤 2：运行目标测试确认失败**
  运行 `npm --prefix "D:/PROJECT_ZZZZZZZZZ/博客项目最终版本" exec -- vitest run tests/lib/github-backup-service.test.ts`。预期候选任务当前错误返回 `verifiedFullBackup: true`。
- [ ] **步骤 3：实现最小语义区分**
  在 handler 捕获快照后，只有 job 输入中 generation 为有效 string、contentSequence 为非负 safe integer、没有 candidateReleaseId，且捕获到的 generation/sequence 精确匹配冻结输入时返回完整备份标志。候选任务只 persist proof 并返回 remoteCommit。手动完整备份若没有水位字段时不冒充水位任务。
- [ ] **步骤 4：运行 service 与 backup 契约测试**
  运行 `npm --prefix "D:/PROJECT_ZZZZZZZZZ/博客项目最终版本" exec -- vitest run tests/lib/github-backup-service.test.ts tests/lib/github-backup.test.ts`。预期全部通过。

## 任务 2：从启动边界启动可停止 worker

- [ ] **步骤 1：先写 worker 生命周期测试**
  扩展 `startup-tasks.test.ts`，mock `runJobWorkerLoop` 与 `createConfiguredGitHubBackupClient`，确认首次 startup 只创建一次 controller/worker，handler 只含可配置的 `backup` handler，reset 后 abort signal 为 aborted，重复 startup 不会重复 worker。
- [ ] **步骤 2：运行测试确认失败**
  运行 `npm --prefix "D:/PROJECT_ZZZZZZZZZ/博客项目最终版本" exec -- vitest run tests/lib/startup-tasks.test.ts`。预期因目前无 worker 接线而失败。
- [ ] **步骤 3：在 startup task 添加 worker 启动与停止**
  使用模組級 `AbortController | null`。启动時动态 import `runJobWorkerLoop` 與 backup service/client factory，建立 client 后以 `{ handlers: { backup: createGitHubBackupJobHandler(client) }, signal }` 啟动循环；捕获并记录去敏错误。导出 `stopServerStartupTasks()`：abort、clear timer、release runtime lease、reset started 标志；测试 reset 调用该 stop。不要注册没有实现的 job type handler。
- [ ] **步骤 4：运行启动任务与水位测试**
  运行 `npm --prefix "D:/PROJECT_ZZZZZZZZZ/博客项目最终版本" exec -- vitest run tests/lib/startup-tasks.test.ts tests/lib/github-backup-service.test.ts tests/lib/jobs-watermark.test.ts`。若实际水位测试文件名不同，先从 `tests/lib` 列表选对应的现有单文件。

## 任务 3：文章历史 GET/恢复 POST API

- [ ] **步骤 1：新增 route contract tests**
  测试中 mock session/write auth 与 GitHub history factory。GET 断言 page/perPage whitelist、nextPage、no-store；缺少会话时不初始化 client。POST 断言无效 commit 拒绝、不满足 CSRF/Origin 拒绝、expectedRevision 冲突不写、成功返回恢复草稿而不发布。
- [ ] **步骤 2：运行测试确认失败**
  运行 `npm --prefix "D:/PROJECT_ZZZZZZZZZ/博客项目最终版本" exec -- vitest run tests/app/article-history-routes.test.ts`。预期新 route 缺失。
- [ ] **步骤 3：实现两个 Route Handler**
  使用 Next App Router `params: Promise<{ id: string }>`。GET 先 `ensureEditorSession`，限制 `page>=1`、`perPage` 默认 20 且最大 100，读取 connected GitHub backup connection；历史 client 使用 `createGitHubArticleHistoryApi({repository: connection.repos.backup, tokenProvider: new GitHubAppTokenManager(...)})`。失败返回通用 502 文案，不回显网络内部细节。所有响应设置 `Cache-Control: no-store`。
  POST 先 `ensureEditorWriteRequest`，body 使用 `EDITOR_JSON_BODY_LIMIT_BYTES`，接受 `{commitSha, expectedRevision}` 且 commit SHA 为 40 hex；读取最新文章及其 manifest revision，revision 不匹配返回 409。调用 `restoreArticleHistoryVersion` 时注入 `writeDrafts` 为 `writeArticlesToDiskIfRevisionMatches(next, expectedRevision)`，成功后使公开内容 cache invalidation 并返回 `{article, revision}`；恢复本身通过现有写入路径登记新的 backup mutation，但不触发发布。
- [ ] **步骤 4：运行 API 与 article history 单测**
  运行 `npm --prefix "D:/PROJECT_ZZZZZZZZZ/博客项目最终版本" exec -- vitest run tests/app/article-history-routes.test.ts tests/lib/article-history.test.ts`。预期全部通过。

## 任务 4：文章列表接入历史与恢复

- [ ] **步骤 1：先写 UI 行为测试**
  扩展 `editor-blog-page.test.tsx`：history action 存在且可访问；点开请求 `/api/editor/articles/article-1/history?page=1&perPage=10` 并呈现保存时间/正文摘要；点击恢复后发送原 revision 和 commit SHA；成功显示“已恢复为草稿”，保留焦点样式；失败显示可理解错误。
- [ ] **步骤 2：运行 UI 测试确认失败**
  运行 `npm --prefix "D:/PROJECT_ZZZZZZZZZ/博客项目最终版本" exec -- vitest run tests/app/editor-blog-page.test.tsx`。预期历史入口与交互当前缺失。
- [ ] **步骤 3：在 ArticleCard 和 BlogEditorPage 实现历史交互**
  新增 history callback；卡片按钮有清晰 aria-label、`min-h-11 min-w-11` 和 `focus:ring-2` 样式。Page 为当前打开历史 article 管理分页与 pending/error 状态；调用 GET `cache: 'no-store'`，POST 使用 `createEditorCsrfHeaders`、`credentials: 'include'` 和当前文章 revision。恢复成功后使用既有 `updateArticle(id, restoredArticle)` 同步 UI；若 hook 的 updateArticle 只接受 Partial<Article>，按其实际签名调用。遇 409 显示刷新后重试提示并不覆盖本地数据。历史正文显示在 `pre` 中作为文本，不注入 HTML。
- [ ] **步骤 4：运行 UI 测试**
  运行 `npm --prefix "D:/PROJECT_ZZZZZZZZZ/博客项目最终版本" exec -- vitest run tests/app/editor-blog-page.test.tsx`。预期全部通过。

## 任务 5：收尾验证与经验沉淀

- [ ] **步骤 1：运行精简 T05 聚焦集**
  运行 `npm --prefix "D:/PROJECT_ZZZZZZZZZ/博客项目最终版本" exec -- vitest run tests/lib/github-backup.test.ts tests/lib/article-history.test.ts tests/lib/github-backup-service.test.ts tests/lib/startup-tasks.test.ts tests/app/article-history-routes.test.ts tests/app/editor-blog-page.test.tsx`。预期所有被选用例通过，不运行全量 Vitest。
- [ ] **步骤 2：运行 lint 与全项目 typecheck**
  分别运行 `npm --prefix "D:/PROJECT_ZZZZZZZZZ/博客项目最终版本" run lint` 与 `npm --prefix "D:/PROJECT_ZZZZZZZZZ/博客项目最终版本" run typecheck`。预期成功；真实 GitHub 备份仍标记未验证。
- [ ] **步骤 3：将稳定经验写入 memory.md**
  记录 worker 生命周期必须绑定 AbortSignal 并使用动态 import，候选 proof 不能置位全局 watermark，文章恢复必须用当前 revision CAS 写入、先保护草稿且 no-store。保留已有记忆内容。
- [ ] **步骤 4：复查 diff/status**
  检查只触及本计划允许文件；不清理既有工作区文件、不提交、不推送。最终报告文件绝对路径及验证真实结果。
