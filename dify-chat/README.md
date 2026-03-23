# Dify Chat Console

一个移动端优先的 H5 聊天控制台，以 Dify 为主要后端，同时支持 OpenAI 兼容接口。

## 功能特性

- **多供应商支持**：Dify、OpenAI、阿里千问（Qwen）、Ollama 本地模型、任意 OpenAI 兼容网关
- **流式 / 普通模式**：支持 Server-Sent Events（SSE）实时流式输出，也可切换为普通阻塞模式
- **文件上传**：Dify 供应商支持多文件上传，文件上传成功后自动附带到消息中
- **思维链展示**：自动识别并展开 `<think>` / `<thought>` 等标签内的推理过程
- **对话历史**：会话记录持久化到浏览器 localStorage，支持切换和删除
- **移动端适配**：全屏聊天布局，适配 iOS 安全区域（刘海 / 底部 Home Bar），键盘弹起时布局自适应
- **本地存储**：所有设置仅保存在本地浏览器，不上传任何服务器

## 技术栈

| 类别 | 技术 |
|------|------|
| 框架 | Vue 3 + TypeScript |
| 构建工具 | Vite |
| 样式 | Tailwind CSS 3 + PostCSS |
| 状态管理 | Vue 3 Composition API（reactive / ref） |
| HTTP | Fetch API + 自定义 SSE 读取器 |
| 持久化 | Browser localStorage |

## 快速开始

```bash
# 安装依赖
npm install

# 启动开发服务器（默认 http://localhost:5173）
npm run dev

# 生产构建
npm run build

# 预览生产构建
npm run preview
```

## 配置说明

长按右上角「新建对话」图标 **5 秒**进入设置面板。

### Dify

| 字段 | 说明 |
|------|------|
| Base URL | Dify API 地址，默认 `https://api.dify.ai` |
| API Key | Dify 应用密钥（`app-...` 或 `sk-...`） |
| User ID | 用户标识，用于追踪会话，首次使用自动生成 |
| Conversation ID | 首条消息后自动填充，重置可清空以开启新会话 |
| Inputs JSON | 可选，传递给 Dify 应用的 `inputs` 对象（JSON 格式） |

> Dify 支持文件上传。若服务端限制文件类型，请更换格式后重试。

### OpenAI 官方

| 字段 | 说明 |
|------|------|
| Base URL | 默认 `https://api.openai.com/v1` |
| API Key | OpenAI API Key |
| 模型名称 | 如 `gpt-4o`、`gpt-3.5-turbo` |
| 系统提示词 | 可选的 System Prompt |

### 阿里千问（Qwen）

与 OpenAI 兼容，填写阿里云百炼的 Base URL 和 API Key。

| 字段 | 说明 |
|------|------|
| Base URL | 如 `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| API Key | 阿里云百炼 API Key |
| 模型名称 | 如 `qwen-max`、`qwen-turbo` |

### OpenAI 兼容（其他网关）

适用于任何实现了 `/v1/chat/completions` 的服务。

### 本地模型（Ollama）

| 字段 | 说明 |
|------|------|
| Base URL | 默认 `http://localhost:11434/v1` |
| API Key | Ollama 本地部署通常不需要 |
| 模型名称 | 如 `llama3`、`mistral`、`deepseek-r1` |

## 本地存储 Key

| Key | 内容 |
|-----|------|
| `dify-chat-settings-v1` | 供应商配置（JSON） |
| `dify-chat-history-v1` | 对话历史列表（JSON） |
| `dify-chat-history-active` | 当前激活的对话 ID |

## 部署

项目构建后是静态 SPA，可部署到任意 Web 服务器。项目内附带 `src/nginx.conf` 供参考：

```nginx
location / {
    try_files $uri $uri/ /index.html;
}
```

> **注意**：浏览器直接请求 API 需要服务端开启 **CORS**。如遇跨域问题，可在前端和后端之间部署本地反向代理。

## 项目结构

```
dify-chat/
├── src/
│   ├── App.vue           # 主应用组件（UI + 状态管理）
│   ├── main.ts           # Vue 入口
│   ├── style.css         # 全局样式（Tailwind + 自定义组件）
│   └── lib/
│       ├── api.ts        # Dify / OpenAI API 客户端
│       └── stream.ts     # SSE 流式读取器
├── public/
│   ├── favicon.svg
│   └── icons.svg         # SVG 图标集合
├── index.html
├── package.json
├── tailwind.config.js
└── vite.config.ts
```

## 注意事项

- 文件上传仅 Dify 供应商支持，其他供应商的上传按钮处于禁用状态
- 流式模式依赖服务端支持 SSE；若服务端不支持，请切换为普通模式
- 对话历史仅保存在本地浏览器，清除浏览器数据会导致历史丢失
- Dify `inputs` 仅在新会话（`conversationId` 为空时）生效
