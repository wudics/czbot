# 村长智能体 (czbot)

基于 opencode SDK 的桌面智能体应用，支持多模型提供商、自定义 Agent、Skills/MCP 插件、文件附件和权限管理。

## 功能

- **多模型支持** — 同时对接 opencode Zen 免费模型和第三方 API（SiliconFlow 等），每 Provider 独立配置模型参数
- **自定义 Agent** — 内置 build（执行模式）和 plan（规划模式）两种 Agent，可创建自定义角色，配置工具权限（allow/ask/deny/inherit）
- **Skills 插件** — 从 `./skills` 目录加载可插拔能力，支持技能级别的权限覆盖
- **MCP 服务器** — 支持 Local 和 Remote 两种模式，运行时挂载外部数据源
- **文件附件** — 支持图片拖拽/选择上传，非 toolcall 模型通过 base64 `image_url` 直调 API
- **权限管理** — 运行时权限弹卡，支持"允许一次"和"始终允许"（会话级缓存）
- **深色模式** — 完整深色主题
- **WeKnora 集成** — 知识库检索，RAG 增强，可明确使用MCP工具：weknora_search为普通检索、weknora_knowledge_chat为图谱增强检索，注意：图谱增强检索需要weknora后台知识库配置了图谱功能和AI智能体才能正常使用

## 快速开始

### 依赖

- Node.js 20+
- npm

### 安装

```bash
npm install
```

### 开发

```bash
npm run dev
```

### 构建

```bash
npm run dist       # Linux AppImage
npm run dist:win   # Windows
```

## 配置

首次启动在当前目录生成 `config.json`：

```jsonc
{
  "providers": [
    {
      "name": "deepseek",
      "model": "deepseek-v4-flash",
      "apiKey": "sk-xxx",
      "baseUrl": "",
      "modelCfg": {
        "tool_call": true,
        "attachment": false
      }
    }
  ],
  "agents": [
    { "id": "plan", "name": "规划模式", "builtin": true, "toolPermissions": { "write": "ask", "edit": "ask", "patch": "ask", "bash": "ask" } }
  ],
  "mcpServers": [
    { "name": "amap", "type": "remote", "enabled": true, "url": "https://...", "permission": "allow" }
  ],
  "activeProvider": "deepseek",
  "activeModel": "deepseek-v4-flash",
  "activeAgent": "build",
  "theme": "light"
}
```

## 项目结构

```
├── src/
│   ├── main/            # Electron 主进程
│   │   ├── index.ts     # IPC handlers, opencode server 管理
│   │   ├── configStore.ts  # config.json 读写
│   │   ├── db.ts        # SQLite 会话/消息存储
│   │   └── sessionStore.ts # 会话 CRUD
│   ├── preload/         # 预加载脚本 & IPC 类型声明
│   └── renderer/        # React UI
│       └── src/
│           ├── App.tsx
│           ├── components/  # SettingsDialog, ChatView, PermissionCard...
│           ├── hooks/       # useChat
│           └── lib/         # variants, utilities
├── resources/           # 图标, WeKnora MCP 脚本
├── docs/                # 开发文档
└── workspace/           # 默认工作目录
```

## 技术栈

- **框架**: Electron 33 + React 19 + TypeScript 6
- **构建**: electron-vite + Vite 6
- **样式**: Tailwind CSS 3 + Radix UI
- **AI**: opencode SDK (V2) + opencode CLI
- **存储**: SQLite (sql.js) + config.json
