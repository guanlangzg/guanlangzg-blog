# 导航数据 Schema 规范

> **文件版本**：2026-03  
> **数据文件路径**：`content/seeds/navigation/data/tools.json`  
> **维护说明**：每次修改 `tools.json` 结构时，同步更新本文档  

---

## 顶层结构

`tools.json` 的顶层是一个 **JSON 数组**，每个元素代表一个**导航分类（Category）**。

```json
[ Category, Category, ... ]
```

---

## Category 对象字段说明

| 字段名 | 类型 | 必填 | 约束说明 |
|--------|------|------|---------|
| `name` | string | ✅ 必填 | 分类显示名称，中文，建议 2-8 字 |
| `icon` | string | ✅ 必填 | 图标标识符，小写英文，与前端 icon 组件注册名一致；当前可用值见下方枚举 |
| `slug` | string | ✅ 必填 | URL 友好标识符，建议小写英文字母和连字符；系统会规范化并要求全局唯一 |
| `tools` | Tool[] | ✅ 必填 | 该分类下的导航条目数组；编辑草稿可为空，正式展示建议至少 1 个 Tool |

### icon 可用值枚举

当前前端已注册的 icon 名称（新增 icon 需同步前端组件）：

```
blog | link | idea | search | responsive
```

---

## Tool 对象字段说明

| 字段名 | 类型 | 必填 | 约束说明 |
|--------|------|------|---------|
| `icon` | string | ✅ 必填 | 与父分类的 `icon` 字段保持一致 |
| `title` | string | ✅ 必填 | 网站或工具的名称，建议 2-20 字 |
| `description` | string | ✅ 必填 | 简介文字，建议 15-60 字；禁止使用"这是一个..."等废话套话 |
| `url` | string | ✅ 必填 | 完整 URL；必须以 `https://` 开头；禁止使用 `http://`（安全要求） |
| `tags` | string[] | ✅ 必填 | 标签数组，建议 1-3 个，中文为主；禁止空数组 `[]` |

---

## 合法示例

```json
[
  {
    "name": "开发工具",
    "icon": "link",
    "slug": "dev-tools",
    "tools": [
      {
        "icon": "link",
        "title": "GitHub",
        "description": "全球最大的开源社区和代码托管平台，支持 Git 版本控制与协作开发",
        "url": "https://github.com",
        "tags": ["代码", "开源", "协作"]
      },
      {
        "icon": "link",
        "title": "MDN Web Docs",
        "description": "Mozilla 官方 Web 技术文档，覆盖 HTML、CSS、JavaScript 权威参考",
        "url": "https://developer.mozilla.org",
        "tags": ["文档", "Web"]
      }
    ]
  }
]
```

---

## 常见错误示例（禁止出现）

```json
// ❌ 错误：url 使用 http
{ "url": "http://example.com" }

// ❌ 错误：tags 为空数组
{ "tags": [] }

// ❌ 错误：slug 重复或包含空白
{ "slug": "dev tools" }

// ❌ 错误：description 过短
{ "description": "好用" }
```

---

## 变更记录

| 日期 | 变更说明 | 操作人 |
|------|---------|--------|
| 2026-03-13 | 初版创建，定义 Category 和 Tool 字段规范 | Codex |
