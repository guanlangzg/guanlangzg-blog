'use client';

import {
  Archive,
  CheckCircle2,
  Compass,
  FileText,
  Settings,
  SlidersHorizontal,
} from 'lucide-react';
import { LogoutButton } from '../components/LogoutButton';
import {
  EditorActionCard,
  EditorMain,
  EditorPage,
  EditorTopBar,
} from '../components/EditorShell';
import { LocalBackupPanel } from '../components/LocalBackupPanel';

const sectionHeadingClass = 'mb-2 text-xs font-semibold uppercase tracking-widest text-subtle';

export default function EditorHomePage() {
  return (
    <EditorPage>
      <EditorTopBar
        title="编辑中心"
        description="管理博客文章、导航链接和可迁移数据"
        actions={(
          <>
            <LogoutButton />
          </>
        )}
      />

      <EditorMain width="lg" className="space-y-8">
        <section aria-labelledby="editor-section-content">
          <h2 id="editor-section-content" className={sectionHeadingClass}>创作</h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <EditorActionCard
              href="/editor/blog"
              icon={FileText}
              title="博客编辑器"
              description="使用 Markdown 编写文章，保留实时预览、模板和本地优先保存。"
              action="开始写作"
            />

            <EditorActionCard
              href="/editor/navigation"
              icon={Compass}
              title="导航编辑器"
              description="管理分类、工具链接和标签，让公开导航页保持可搜索、可迁移。"
              action="编辑导航"
            />
          </div>
        </section>

        <section aria-labelledby="editor-section-publish">
          <h2 id="editor-section-publish" className={sectionHeadingClass}>发布</h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <EditorActionCard
              href="/editor/publishing"
              icon={CheckCircle2}
              title="发布工作台"
              description="按范围创建冻结候选、预览版本并跟踪真实发布任务；GitHub 连接配置也在发布工作台顶部。"
              action="查看发布状态"
            />
          </div>
        </section>

        <section aria-labelledby="editor-section-data">
          <h2 id="editor-section-data" className={sectionHeadingClass}>数据与备份</h2>
          <div className="grid gap-3 lg:grid-cols-2">
            <EditorActionCard
              href="/editor/backups"
              icon={Archive}
              title="GitHub 备份与恢复"
              description="查看私有远端备份历史，审阅逐项冲突后合并恢复当前草稿。"
              action="管理备份与恢复"
            />

            <LocalBackupPanel />
          </div>
        </section>

        <section aria-labelledby="editor-section-site" aria-label="站点与运维">
          <h2 id="editor-section-site" className={sectionHeadingClass}>站点与运维</h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <EditorActionCard
              href="/editor/settings"
              icon={Settings}
              title="站点设置"
              description="管理公开站点名称、描述和首页首屏文案，并随备份一起迁移。"
              action="调整设置"
            />

            <EditorActionCard
              href="/editor/settings/runtime"
              icon={SlidersHorizontal}
              title="运行时配置"
              description="管理首次启动变量、Cookie、代理、站点 URL、数据目录和编辑口令。"
              action="配置变量"
            />
          </div>
        </section>
      </EditorMain>
    </EditorPage>
  );
}
