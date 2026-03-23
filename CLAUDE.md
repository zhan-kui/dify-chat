# CLAUDE.md — Dify Chat Console

本文件为 Claude Code 提供项目上下文，帮助 AI 助手快速理解代码库并做出准确的修改。

## 项目概述

**dify-chat** 是一个移动端优先的 H5 聊天界面，支持多个 AI 后端供应商（Dify、OpenAI、Qwen、Ollama、OpenAI 兼容网关）。采用 Vue 3 + TypeScript + Tailwind CSS，构建工具为 Vite。

### 核心目录结构

```
dify-chat/              ← 项目根目录（含 package.json）
├── src/
│   ├── App.vue         ← 唯一的业务组件，包含全部 UI + 状态逻辑（~1400 行）
│   ├── main.ts         ← Vue 挂载入口
│   ├── style.css       ← 全局样式（Tailwind @layer base/components/utilities）
│   └── lib/
│       ├── api.ts      ← API 客户端（Dify + OpenAI 兼容）
│       └── stream.ts   ← SSE 流式读取器
├── public/
│   └── icons.svg       ← SVG 图标 sprite
├── index.html          ← HTML 入口，含 viewport meta
├── tailwind.config.js  ← 自定义颜色、阴影、动画
└── vite.config.ts
```

## 开发命令

```bash
cd dify-chat          # 所有命令在此目录运行
npm install           # 安装依赖
npm run dev           # 启动开发服务器（http://localhost:5173）
npm run build         # TypeScript 检查 + Vite 生产构建
npm run preview       # 预览生产构建
```

## 关键文件说明

### `src/App.vue`

单文件组件，**不拆分子组件**——整个应用的 UI 和状态都在这里。

**重要类型：**
```typescript
type ProviderId = "dify" | "openai" | "qwen" | "openai_compat" | "ollama"
type Message = { id, role, content, attachments?, time? }
type Conversation = { id, title, messages, providerId, difyConversationId?, updatedAt }
```

**状态管理：**
- `settings` — 供应商配置，watch 后自动持久化到 localStorage
- `messages` — 当前对话消息数组
- `conversations` — 历史对话列表
- `status` — `"idle" | "sending" | "streaming"`

**关键 computed：**
- `formattedMessages` — 处理 `<think>` 标签，返回带 `think`/`answer`/`isThinking` 字段的消息
- `compatConfig` — 根据 `settings.providerId` 返回当前供应商的 OpenAI 兼容配置
- `sendEnabled` / `isBusy` / `isConfigured` — 控制按钮状态

**长按逻辑：**右上角新建对话按钮短按=新建，长按 5 秒=打开设置弹窗。

### `src/lib/api.ts`

纯函数模块，不引入任何框架依赖。

- `uploadDifyFile(baseUrl, apiKey, user, file)` — 上传文件到 Dify，返回 `{ id }`
- `sendDifyChat(params, onChunk, signal)` — Dify SSE 流式聊天
- `sendOpenAIChat(params, onChunk, signal)` — OpenAI 兼容聊天（流式/普通）

### `src/lib/stream.ts`

- `readEventStream(body, onChunk)` — 读取 SSE 响应，逐行解析 `data:` 前缀，回调每个事件

### `src/style.css`

使用 Tailwind `@layer` 组织：
- `@layer base` — CSS 变量（颜色令牌）、body 背景渐变、dot-grid 纹理
- `@layer components` — 可复用组件类（`.card`, `.btn-*`, `.bubble-*`, `.icon-btn`, `.chat-shell` 等）
- `@layer utilities` — 动画 keyframes、滚动条样式

**颜色令牌（CSS 变量）：**
```
--bg, --surface, --ink, --muted, --accent, --accent-2, --line, --glow
```
在 Tailwind 中通过 `bg-bg`, `text-accent`, `border-line` 等使用。

### `tailwind.config.js`

扩展了以下内容：
- `colors` — bg、surface、ink、muted、accent、accent-2、line、glow
- `boxShadow` — soft、lift
- `animation` — float、fadeUp

## 代码规范

1. **Vue 3 Composition API**：使用 `<script setup>` 语法，不使用 Options API
2. **样式优先用 Tailwind 工具类**；组件级可复用样式定义在 `style.css` 的 `@layer components`
3. **不引入新的 npm 包**，除非绝对必要
4. **TypeScript 严格模式**：`tsconfig.app.json` 开启了 strict，注意类型安全
5. **localStorage 序列化**：设置和历史通过 `JSON.stringify/parse` 手动同步，无 ORM
6. **错误处理**：用户可见错误写入 `error` ref，信息提示写入 `info` ref，两者会自动消失

## 注意事项 / 禁忌

- **不要拆分组件**：App.vue 是有意设计为单组件，除非用户明确要求拆分
- **不要引入路由**：无多页面需求
- **不要修改 localStorage key**（`dify-chat-settings-v1` 等）：会导致用户已保存数据丢失，如需修改需做迁移
- **文件上传仅 Dify 支持**：`canUpload` computed 控制，修改时注意同步
- **流式输出时 UI 更新**：通过 `nextTick` + `scheduleScroll` 确保滚动到底部，修改消息列表渲染时需保持这个逻辑
- **长按计时器**：`longPressTimer` 是 `number | null` 类型，页面卸载时记得 `onUnmounted` 清理

## 常见修改场景

### 添加新的 AI 供应商
1. 在 `ProviderId` 类型中添加新 ID
2. 在 `providers` 数组中添加 label 和 hint
3. 在 `settings` 默认值中添加配置对象
4. 在 `compatConfig` computed 中处理映射
5. 在模板设置面板中添加对应输入字段

### 修改消息气泡样式
修改 `style.css` 中的 `.bubble`, `.bubble-user`, `.bubble-assistant` 类。

### 添加新的键盘快捷键
在模板 `<textarea>` 的 `@keydown` 处理器中添加。

### 修改对话历史逻辑
核心函数：`syncConversation()`, `selectConversation()`, `deleteConversation()`, `clearAllHistory()`
