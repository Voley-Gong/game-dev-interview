# 🎮 游戏客户端开发面试指南

> 一站式游戏客户端开发面试准备网站，涵盖 Cocos Creator、Unity、编程基础、架构设计、网络同步和非技术面试。

## 🌐 在线访问

[https://voley-gong.github.io/game-dev-interview/](https://voley-gong.github.io/game-dev-interview/)

## 📚 内容结构

| 层级 | 说明 | 示例 |
|------|------|------|
| 📗 L1 基础 | 入门必知 | 引擎生命周期、设计模式基础 |
| 📘 L2 进阶 | 中高级必考 | 性能优化、协议选型 |
| 📕 L3 架构 | 主程核心考察 | UI 框架、技能系统设计 |
| 📙 L4 深度 | 大厂/专家专项 | DOTS/ECS、大世界方案 |

## 🛠️ 技术栈

- **Astro 6** + React — Islands 架构，零 JS 输出
- **Content Collections** — 结构化 Markdown 管理题目
- **Pagefind** — 全文搜索
- **GitHub Pages** — 自动部署

## 🚀 本地开发

```bash
npm install
npm run dev      # 开发服务器
npm run build    # 构建 + Pagefind 索引
npm run preview  # 预览构建结果
```

## 📝 添加新题目

在 `src/content/questions/` 对应分类下创建 Markdown 文件：

```markdown
---
title: "你的问题标题"
category: "cocos"  # cocos | unity | programming | architecture | network | soft-skills
level: 2           # 1-4
tags: ["标签1", "标签2"]
hint: "一句话提示"
---

## 参考答案

### ✅ 核心要点
1. ...

### 📖 深度展开
...

### ⚡ 实战经验
...
```

## License

MIT
