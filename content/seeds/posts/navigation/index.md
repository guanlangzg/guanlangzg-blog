---
layout: doc
title: 网址导航
---

# 网址导航

<script setup>
import tools from './data/tools.json'
</script>

<div class="page-intro">
  <p>收藏优质网站与工具，按分类组织，便于快速查找与访问。</p>
</div>

<div class="gradient-divider"></div>

<ToolGrid
  v-for="category in tools"
  :key="category.slug"
  :title="category.name"
  :icon="category.icon"
  :tools="category.tools"
/>
