import { ArticleTemplate } from '@/app/types/article';

export const articleTemplates: ArticleTemplate[] = [
  {
    id: 'til',
    name: 'TIL 短笔记',
    category: '快速沉淀',
    group: 'quick',
    kind: 'til',
    defaultStatus: 'seedling',
    description: '记录今天刚学到的一个事实、命令或判断，保持低成本更新。',
    icon: 'Lightbulb',
    estimatedMinutes: 8,
    highlights: ['一句结论', '最小例子', '延伸问题'],
    bestFor: ['新发现', '小技巧', '命令备忘'],
    output: '一条未来能搜索到的知识卡片。',
    requiredSections: ['今天学到', '例子', '下一步'],
    qualityRules: [
      { id: 'short-note-focus', label: '只回答一个问题', severity: 'suggestion' },
      { id: 'example-present', label: '包含一个可复用例子', severity: 'warning' },
    ],
    frontmatter: {
      title: 'TIL：一个刚学到的小知识',
      description: '用一句话说明这条笔记解决了什么具体问题。',
      tags: ['TIL'],
      kind: 'til',
      status: 'seedling',
      category: '工具与效率',
    },
    content: `# TIL：一个刚学到的小知识

## 今天学到

把结论写成一句未来能搜索到的话。

## 例子

\`\`\`bash
command --flag value
\`\`\`

## 为什么有用

说明它替代了什么旧做法，或者避免了什么误解。

## 下一步

- [ ] 需要继续验证的问题
`,
  },
  {
    id: 'link-note',
    name: '链接短评',
    category: '快速沉淀',
    group: 'quick',
    kind: 'link',
    defaultStatus: 'published',
    description: '围绕一篇外部文章、项目或工具写判断，不只收藏链接。',
    icon: 'Link2',
    estimatedMinutes: 10,
    highlights: ['原文链接', '核心判断', '适用边界'],
    bestFor: ['外链评论', '资料收藏', '观点摘录'],
    output: '一条带作者判断的链接记录。',
    requiredSections: ['链接', '我的判断', '适用边界'],
    frontmatter: {
      title: '链接短评：值得保留的一篇资料',
      description: '概括原文最有价值的观点，以及我为什么保留它。',
      tags: ['链接', '阅读'],
      kind: 'link',
      status: 'published',
      category: '阅读与写作',
    },
    content: `# 链接短评：值得保留的一篇资料

## 链接

- [原文标题](https://example.com)

## 原文说了什么

用 3-5 句话复述对方的核心观点。

## 我的判断

写清楚我赞同、保留或反对的部分。

## 适用边界

这条资料在哪些场景有用，哪些场景不该直接套用。
`,
  },
  {
    id: 'notes',
    name: '学习笔记',
    category: '快速沉淀',
    group: 'quick',
    kind: 'til',
    defaultStatus: 'seedling',
    description: '整理一个主题的概念、例子、易错点和待深入问题。',
    icon: 'NotebookPen',
    estimatedMinutes: 15,
    highlights: ['概念卡片', '例子', '待深入'],
    bestFor: ['课程笔记', '文档学习', '主题入门'],
    output: '一组可继续扩写的概念卡片。',
    requiredSections: ['核心概念', '待深入'],
    frontmatter: {
      title: '学习笔记',
      description: '记录一个主题的核心概念、示例和延伸问题。',
      tags: ['学习', '笔记'],
      kind: 'til',
      status: 'seedling',
      category: '阅读与写作',
    },
    content: `# 学习笔记

## 今天要掌握

- 概念 1：
- 概念 2：
- 概念 3：

## 核心概念

### 概念 1

用自己的话解释。

### 概念 2

补一个最小例子。

\`\`\`typescript
interface Note {
  title: string;
  tags: string[];
  updatedAt: number;
}
\`\`\`

## 易错点

- 易错点 1：
- 易错点 2：

## 待深入

- [ ] 问题 1
- [ ] 问题 2
`,
  },
  {
    id: 'tutorial',
    name: '技术教程',
    category: '深度资产',
    group: 'deep',
    kind: 'guide',
    defaultStatus: 'draft',
    description: '从问题、环境、步骤到验证，适合写可复现的实践文章。',
    icon: 'BookOpen',
    estimatedMinutes: 25,
    highlights: ['环境准备', '步骤拆解', '结果验证'],
    bestFor: ['落地教程', '实践手册', '内部运行手册'],
    output: '一篇读者能照着完成并验证结果的教程。',
    requiredSections: ['背景', '环境准备', '实现步骤', '验证', '总结'],
    frontmatter: {
      title: '从零实现一个功能',
      description: '记录一个功能从背景、方案到落地验证的完整过程。',
      tags: ['技术', '教程'],
      kind: 'guide',
      status: 'draft',
      category: '工程实践',
    },
    content: `# 从零实现一个功能

## 背景

说明要解决的具体问题、影响范围，以及为什么现在要处理它。

## 目标

- 目标 1：
- 目标 2：
- 非目标：

## 环境准备

| 项目 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | 22.x | 本地运行环境 |
| npm | 11.x | 包管理器 |

## 实现步骤

### 步骤 1：建立最小闭环

先完成可以运行、可以验证的最小实现。

\`\`\`typescript
type Result<T> = {
  ok: boolean;
  data?: T;
  error?: string;
};
\`\`\`

### 步骤 2：补齐边界

说明错误路径、空状态、权限或数据迁移等边界。

## 验证

- [ ] 单元测试通过
- [ ] 构建通过
- [ ] 主路径手动验证

## 总结

收束关键经验，以及下次可以复用的判断。
`,
  },
  {
    id: 'research',
    name: '研究长文',
    category: '深度资产',
    group: 'deep',
    kind: 'deep-dive',
    defaultStatus: 'draft',
    description: '用于沉淀调研、证据链和结论，适合长期被引用。',
    icon: 'Microscope',
    estimatedMinutes: 45,
    highlights: ['问题定义', '证据链', '可修订结论'],
    bestFor: ['技术调研', '行业分析', '方案评估'],
    output: '一篇有来源、有假设、有结论边界的研究文章。',
    requiredSections: ['问题', '结论摘要', '证据', '取舍', '参考资料'],
    qualityRules: [
      { id: 'sources-required', label: '研究类文章需要参考资料', severity: 'warning' },
      { id: 'assumptions-explicit', label: '明确写出假设和边界', severity: 'suggestion' },
    ],
    frontmatter: {
      title: '一次主题研究记录',
      description: '概括这次研究的问题、核心结论和适用边界。',
      tags: ['研究', '分析'],
      kind: 'deep-dive',
      status: 'draft',
      category: '架构设计',
    },
    content: `# 一次主题研究记录

## 问题

这篇文章要回答的核心问题是什么？为什么它值得花时间研究？

## 结论摘要

- 结论 1：
- 结论 2：
- 暂不确定：

## 背景

补充必要上下文，不写与结论无关的历史。

## 证据

### 证据 1

说明来源、观察到的事实，以及它支撑哪个结论。

### 证据 2

说明另一组事实，避免只有单一来源。

## 取舍

| 方案 | 收益 | 成本 | 适用场景 |
| --- | --- | --- | --- |
| 方案 A |  |  |  |
| 方案 B |  |  |  |

## 结论边界

这些结论在哪些前提下成立，哪些场景不能直接复用。

## 参考资料

- [参考资料标题](https://example.com)
`,
  },
  {
    id: 'deep-dive',
    name: '源码解析',
    category: '深度资产',
    group: 'deep',
    kind: 'deep-dive',
    defaultStatus: 'draft',
    description: '拆解框架、库或项目内部机制，保留清晰调用链。',
    icon: 'Brain',
    estimatedMinutes: 35,
    highlights: ['调用链', '关键源码', '设计取舍'],
    bestFor: ['源码阅读', '架构复盘', '机制解释'],
    output: '一篇能复用调用链和设计判断的源码记录。',
    requiredSections: ['阅读目的', '入口定位', '核心流程', '设计取舍', '结论'],
    frontmatter: {
      title: '一次源码阅读记录',
      description: '从入口、核心流程和边界条件拆解一段源码。',
      tags: ['源码', '架构'],
      kind: 'deep-dive',
      status: 'draft',
      category: '架构设计',
    },
    content: `# 一次源码阅读记录

## 阅读目的

这次阅读要回答的问题：

- 问题 1：
- 问题 2：

## 入口定位

从调用方开始，记录第一个稳定入口。

\`\`\`text
user action
  -> public API
  -> coordinator
  -> storage boundary
\`\`\`

## 核心流程

### 1. 输入规范化

说明输入如何被收敛成内部模型。

### 2. 状态变更

说明状态在哪里变化、谁负责提交副作用。

### 3. 输出生成

说明输出如何回到调用方。

## 关键代码

\`\`\`typescript
export function selectVisibleItems(items: Item[], keyword: string): Item[] {
  const query = keyword.trim().toLowerCase();
  return query ? items.filter((item) => item.title.toLowerCase().includes(query)) : items;
}
\`\`\`

## 设计取舍

| 方案 | 收益 | 成本 |
| --- | --- | --- |
| 当前实现 |  |  |
| 替代方案 |  |  |

## 结论

用 3-5 句话沉淀这段源码真正值得带走的部分。
`,
  },
  {
    id: 'debugging',
    name: '排障复盘',
    category: '经验复盘',
    group: 'review',
    kind: 'debug',
    defaultStatus: 'draft',
    description: '记录现象、假设、验证和根因，沉淀问题处理过程。',
    icon: 'Bug',
    estimatedMinutes: 20,
    highlights: ['时间线', '根因', '预防措施'],
    bestFor: ['线上问题', '构建失败', '性能异常'],
    output: '一篇以后遇到同类问题能直接回看的复盘。',
    requiredSections: ['现象', '时间线', '验证过程', '根因', '预防'],
    frontmatter: {
      title: '一次问题排查复盘',
      description: '记录问题现象、定位过程、根因和后续防护。',
      tags: ['排障', '复盘'],
      kind: 'debug',
      status: 'draft',
      category: '工程实践',
    },
    content: `# 一次问题排查复盘

## 现象

描述用户看到的异常、影响范围和首次发现时间。

## 时间线

| 时间 | 动作 | 结论 |
| --- | --- | --- |
| 10:00 | 收到反馈 |  |
| 10:15 | 检查日志 |  |
| 10:40 | 验证修复 |  |

## 假设

- 假设 1：
- 假设 2：
- 假设 3：

## 验证过程

\`\`\`bash
npm run lint
npm run typecheck
npm run test:run
\`\`\`

## 根因

把根因写成可以被验证的一句话。

## 修复

说明最终改动，以及为什么它解决的是根因。

## 预防

- [ ] 增加回归测试
- [ ] 增加日志或监控
- [ ] 更新运行手册
`,
  },
  {
    id: 'project',
    name: '项目案例',
    category: '经验复盘',
    group: 'review',
    kind: 'project',
    defaultStatus: 'draft',
    description: '覆盖项目背景、目标、关键决策、结果和可复用经验。',
    icon: 'FolderGit2',
    estimatedMinutes: 30,
    highlights: ['目标回顾', '成果指标', '经验沉淀'],
    bestFor: ['作品展示', '阶段总结', '案例页'],
    output: '一篇能说明项目价值和决策质量的案例页。',
    requiredSections: ['项目背景', '目标与结果', '关键决策', '风险与遗留', '下一步'],
    frontmatter: {
      title: '项目阶段总结',
      description: '回顾项目目标、关键产出、问题和下一步计划。',
      tags: ['项目', '总结'],
      kind: 'project',
      status: 'draft',
      category: '项目复盘',
    },
    content: `# 项目阶段总结

## 项目背景

写清楚项目为什么存在，以及它服务谁。

## 目标与结果

| 目标 | 结果 | 备注 |
| --- | --- | --- |
| 目标 1 |  |  |
| 目标 2 |  |  |

## 技术方案

说明架构边界、关键依赖和主要数据流。

\`\`\`mermaid
flowchart LR
  Client --> API
  API --> Storage
  API --> Backup
\`\`\`

## 关键决策

### 决策 1

为什么选它，放弃了什么。

## 风险与遗留

- 风险 1：
- 遗留 1：

## 下一步

- [ ] 计划 1
- [ ] 计划 2
`,
  },
  {
    id: 'release',
    name: '版本记录',
    category: '经验复盘',
    group: 'review',
    kind: 'release',
    defaultStatus: 'published',
    description: '记录一次发布的用户影响、主要改动、验证和观察点。',
    icon: 'Rocket',
    estimatedMinutes: 15,
    highlights: ['变更摘要', '影响范围', '验证清单'],
    bestFor: ['版本发布', '变更日志', '上线记录'],
    output: '一篇能追溯发布影响和验证结论的记录。',
    requiredSections: ['摘要', '主要改动', '用户影响', '验证记录', '后续观察'],
    frontmatter: {
      title: '版本发布记录',
      description: '记录一次版本发布的主要改动、风险和验证结论。',
      tags: ['发布', '记录'],
      kind: 'release',
      status: 'published',
      category: '工程实践',
    },
    content: `# 版本发布记录

## 摘要

一句话说明这次发布给用户带来的变化。

## 主要改动

- 改动 1：
- 改动 2：
- 改动 3：

## 用户影响

| 范围 | 影响 | 处理 |
| --- | --- | --- |
| 页面/API |  |  |

## 验证记录

\`\`\`bash
npm run lint
npm run test:run
npm run build
\`\`\`

## 回滚方案

说明最小回滚路径和需要保留的数据。

## 后续观察

- [ ] 指标 1
- [ ] 日志 1
`,
  },
  {
    id: 'resource',
    name: '资源清单',
    category: '导航入口',
    group: 'entry',
    kind: 'resource',
    defaultStatus: 'evergreen',
    description: '把一组工具、文章或路线整理成可持续维护的入口。',
    icon: 'ListChecks',
    estimatedMinutes: 25,
    highlights: ['筛选标准', '资源分组', '维护记录'],
    bestFor: ['工具清单', '学习路线', '主题入口'],
    output: '一篇可长期更新的主题导航。',
    requiredSections: ['适合谁', '筛选标准', '资源清单', '维护记录'],
    frontmatter: {
      title: '一个主题的资源清单',
      description: '整理一个主题下值得长期保留的资源、适用场景和维护记录。',
      tags: ['资源', '清单'],
      kind: 'resource',
      status: 'evergreen',
      category: '资源导航',
      featured: true,
    },
    content: `# 一个主题的资源清单

## 适合谁

说明这份清单服务的读者，以及不适合谁。

## 筛选标准

- 标准 1：
- 标准 2：
- 排除标准：

## 资源清单

### 入门

- [资源标题](https://example.com)：为什么值得读。

### 进阶

- [资源标题](https://example.com)：适合解决什么问题。

### 工具

- [工具名称](https://example.com)：适用场景和替代方案。

## 使用路径

建议读者按什么顺序使用这些资源。

## 维护记录

- 2026-05-25：首次整理。
`,
  },
  {
    id: 'essay',
    name: '观点随笔',
    category: '导航入口',
    group: 'entry',
    kind: 'essay',
    defaultStatus: 'draft',
    description: '围绕一个判断写清楚背景、论点、反例和结论边界。',
    icon: 'PenLine',
    estimatedMinutes: 20,
    highlights: ['中心论点', '反例', '边界'],
    bestFor: ['个人判断', '工作方法', '写作思考'],
    output: '一篇有清晰立场但不过度泛化的观点文章。',
    requiredSections: ['核心观点', '为什么', '反例', '结论边界'],
    frontmatter: {
      title: '一个值得写清楚的判断',
      description: '用一句话说明这篇随笔的核心观点和读者收获。',
      tags: ['观点', '随笔'],
      kind: 'essay',
      status: 'draft',
      category: '阅读与写作',
    },
    content: `# 一个值得写清楚的判断

## 核心观点

把观点写成一句可以被反驳的话。

## 为什么

说明这个判断来自哪些经历、事实或推理。

## 例子

写一个具体场景，避免只停留在抽象口号。

## 反例

什么情况下这个观点不成立？

## 结论边界

最后收束适用范围和下一步行动。
`,
  },
  {
    id: 'review',
    name: '读书评注',
    category: '导航入口',
    group: 'entry',
    kind: 'review',
    defaultStatus: 'draft',
    description: '整理一本书、一篇论文或一份资料的观点、证据和可复用框架。',
    icon: 'BookMarked',
    estimatedMinutes: 25,
    highlights: ['主张复述', '可用框架', '个人评注'],
    bestFor: ['读书笔记', '论文笔记', '资料评注'],
    output: '一篇能把外部内容转成个人知识资产的评注。',
    requiredSections: ['资料信息', '核心主张', '可复用框架', '我的评注', '参考资料'],
    frontmatter: {
      title: '一份资料的读后评注',
      description: '记录资料的核心主张、可复用框架和我的判断。',
      tags: ['读书', '评注'],
      kind: 'review',
      status: 'draft',
      category: '阅读与写作',
    },
    content: `# 一份资料的读后评注

## 资料信息

- 标题：
- 作者：
- 链接或出处：

## 核心主张

用自己的话复述作者最重要的主张。

## 可复用框架

把能迁移到工作或写作里的框架拆出来。

## 我的评注

哪些部分可信？哪些部分需要保留疑问？

## 行动项

- [ ] 可以马上尝试的一件事

## 参考资料

- [资料标题](https://example.com)
`,
  },
  {
    id: 'start-here',
    name: '从这里开始',
    category: '导航入口',
    group: 'entry',
    kind: 'resource',
    defaultStatus: 'evergreen',
    description: '给新读者一个稳定入口，串起精选文章、主题和项目。',
    icon: 'Map',
    estimatedMinutes: 20,
    highlights: ['精选入口', '主题路径', '持续维护'],
    bestFor: ['首页入口', '专题索引', '个人知识地图'],
    output: '一个帮助读者快速理解这个站点的入口页。',
    requiredSections: ['适合谁', '先读这些', '主题路径', '更新记录'],
    frontmatter: {
      title: '从这里开始',
      description: '给第一次来到这里的读者一个稳定入口，快速找到最值得读的内容。',
      tags: ['精选', '入口'],
      kind: 'resource',
      status: 'evergreen',
      category: '资源导航',
      featured: true,
    },
    content: `# 从这里开始

## 适合谁

说明这个站点主要服务哪些读者。

## 先读这些

- [文章标题](/posts/example)：为什么推荐先读。

## 主题路径

### 工程实践

按学习顺序列出几篇文章。

### 阅读与写作

列出能体现作者判断的文章。

## 项目入口

- 项目 1：
- 项目 2：

## 更新记录

- 2026-05-25：首次整理。
`,
  },
  {
    id: 'blank',
    name: '空白文章',
    category: '快速沉淀',
    group: 'quick',
    kind: 'essay',
    defaultStatus: 'draft',
    description: '只有标题和一个起笔位置，适合快速记录灵感。',
    icon: 'FileText',
    estimatedMinutes: 5,
    highlights: ['自由写作', '最少结构', '快速开始'],
    bestFor: ['灵感记录', '自由写作', '临时草稿'],
    output: '一篇不受结构约束的草稿。',
    requiredSections: [],
    frontmatter: {
      title: '',
      description: '',
      tags: [],
      kind: 'essay',
      status: 'draft',
      category: '',
    },
    content: `# 标题

写下第一段。
`,
  },
];

export function getTemplateById(id: string): ArticleTemplate | undefined {
  return articleTemplates.find((template) => template.id === id);
}

export function getDefaultTemplate(): ArticleTemplate {
  return articleTemplates.find((template) => template.id === 'blank') || articleTemplates[0];
}
