# WeKnora 优化：MCP 方案

## 目标

将 WeKnora 从"主进程拼接上下文"改为 LLM 自主调用的 MCP 工具，实现多次检索、多角度查询的复杂调研能力。

## 架构变化

```
当前（主进程拼接）               MCP 方案（LLM 自主调用）

用户发送消息                     用户发送消息
  ↓                                ↓
主进程调 WeKnora 检索            LLM 推理："需要查公司信息"
  ↓                                ↓
拼接上下文 → LLM                 调 weknora_search({ query: "成立时间", kb_ids })
  ↓                                ↓
LLM 回复                         LLM 推理："再查产品"
                                  ↓
                                 调 weknora_search({ query: "主要产品", kb_ids })
                                  ↓
                                 LLM 综合多次结果回复
```

| 对比 | 当前 | MCP 方案 |
|------|------|---------|
| 检索时机 | 每次用户发消息都检索一次 | LLM 自主决定何时检索、检索几次 |
| 检索次数 | 单次 | 多次，可逐步深入 |
| LLM 参与 | 被动接受拼接上下文 | 主动调用工具、分析结果、决定下一步 |
| 用户可见性 | 不可见 | 思考过程显示 ✅ weknora_search |

## MCP 脚本

### 位置

`resources/weknora-mcp.js`（随应用打包，通过 `extraResources` 分发）

### 通信协议

MCP 脚本通过 stdio JSON-RPC 与 opencode Go 二进制通信，完整协议流程：

```
opencode                            weknora-mcp.js
   │                                      │
   ├─── initialize ─────────────────►     │
   │◄── result {capabilities} ──────────  │
   │                                      │
   ├─── notifications/initialized ───►    │
   │                                      │
   ├─── tools/list ────────────────►      │  ← 关键！标准工具发现
   │◄── result {tools: [...]} ─────────   │
   │                                      │
   ├─── tools/call {name: "search"}  ►    │
   │◄── result {content: [...]} ────────  │
```

脚本同时支持两种注册方式：
1. **启动时主动发送 `tools/setup`** 通知（兼容 opencode 主动注册模式）
2. **响应 `tools/list` 请求**（标准 MCP 协议，核心修复）

### 工具命名

opencode 将 MCP 工具按 `{serverName}_{toolName}` 拼接暴露给 LLM：

| 脚本中注册名 | MCP 服务器名 | LLM 看到 |
|-------------|-------------|---------|
| `search` | `weknora` | `weknora_search` |

### 输入

| 来源 | 数据 | 说明 |
|------|------|------|
| environment | `WEKNORA_URL` | WeKnora 服务器地址 |
| environment | `WEKNORA_API_KEY` | API Key |
| LLM 参数 | `query` | 搜索查询文本 |
| LLM 参数 | `kb_ids` | 用户选择的 KB ID 列表 |

### 注册

`restartOpencode` 中自动注册，用户不需要手动配置：

```typescript
mcpConfig.weknora = {
  type: 'local',
  command: ['node', mcpScriptPath],     // Array<string> 格式，与 SDK 类型一致
  environment: {
    WEKNORA_URL: config.weknoraUrl,
    WEKNORA_API_KEY: config.weknoraApiKey,
  },
  enabled: true,
}
mcpPermissions['mcp__weknora__*'] = 'allow'  // 权限键名: mcp__server__*
```

未配置 URL + API Key 时不启用，用户看不到。

### 权限键名格式

opencode 内部 MCP 工具的权限键为 `mcp__{serverName}__{toolName}`：

- **全局权限**: `mcp__weknora__*` → 允许 weknora 服务器的所有工具
- **per-agent 权限**: `mcp__{serverName}__*` → 允许指定服务器的所有工具
- **DB MCP 服务器权限**: 同样使用 `mcp__{name}__*` 格式

## 系统指令注入

为了让 LLM 知道使用知识库搜索工具，利用 opencode SDK 的 `system` 参数传递 KB 指令，与 agent prompt 追加共存：

```
agent prompt（来自 DB agent 配置）:
  你是一个名为 梯度小助手 的桌面智能体助手。
  重要规则：...

system 参数（来自 ChatView 调用）:
  用户已选择以下知识库：梯度科技（ID: 2d786b93-...）
  如需要查询知识库获取信息，请使用 weknora_search 工具
```

### 数据流

```
之前（坏）:                          现在（好）:

sendMessage(finalText)               sendMessage(text, system)
  ↓                                     ↓
IPC: send-message(text, sid)           IPC: send-message(text, sid, system)
  ↓                                     ↓
promptAsync({                          promptAsync({
  parts: [{                               system: "用户已选择知识库：...",
    text: "[系统指令]...\n\n问题"          parts: [{ text: "问题" }]
  }]                                    })
})
```

### 优点

- 系统指令作为独立字段传给 LLM，与 agent prompt 共存不覆盖
- 对话历史中不显示系统指令，用户消息保持干净
- 不消耗用户消息的 token 预算

### 实现

`ChatView.tsx` 的 `handleSend` 将 KB 指令提取为 `system` 变量传入：

```tsx
const handleSend = useCallback((text: string) => {
  let system = ''
  if (weknoraKbIds.length > 0) {
    const names = weknoraKbs.filter(k => weknoraKbIds.includes(k.id)).map(k => k.name).join('、')
    const ids = weknoraKbIds.join(', ')
    system = `用户已选择以下知识库：${names}（ID: ${ids}）\n如需要查询知识库获取信息，请使用 weknora_search 工具，并传入对应的知识库 ID。`
  }
  sendMessage(text, system || undefined)
}, [weknoraKbIds, weknoraKbs, sendMessage])
```

`send-message` IPC 收到 `system` 后传给 `promptAsync`：

```ts
await opencodeClient.session.promptAsync({
  sessionID: sessionId,
  agent: savedConfig.activeAgent || 'general',
  model: { ... },
  tools,
  ...(system ? { system } : {}),
  parts: [{ type: 'text', text }],
})
```

## 多选 KB 下拉 UI

### 显示

```
📚 [关闭]         ← 未选任何 KB，点击展开
📚 [2个]          ← 部分选中
```

### 展开（固定向上）

```
    ┌──────────────────────┐
    │ ☑ 个人wiki           │ ← 复选框
    │ ☑ 梯度科技           │
    │ ─────────────────── │
    │ 清除选择             │ ← 一键清空
    │ ─────────────────── │
    │ 🔄 刷新             │ ← 手动重新拉取 KB 列表
    └──────────────────────┘
    📚 [2个]
```

### 行为逻辑

- 展开时如列表为空则自动拉取 KB
- 点击复选框切换选中状态
- 点击外部关闭下拉面板（`mousedown` 事件）
- 刷新按钮重新调用 `GET /knowledge-bases`

## 连接状态指示器

初始状态改为 `'reconnecting'`（黄色闪烁），`restartOpencode` 开始时会发送 `'reconnecting'`，health check 通过后变 `'connected'`（绿色），失败后变 `'disconnected'`（红色）。

```tsx
const [connectionStatus, setConnectionStatus] = useState('reconnecting')
```

```
startup ──→ restarOpencode ──→ health check ──→ connected 🟢
  reconnecting 🟡    │              │
                     │              └── failed ──→ disconnected 🔴
                     │                           → auto reconnect (3次)
                     └── stopHealthCheck() 防止旧检查干扰
```

## 删除的代码

| 删除项 | 原因 |
|--------|------|
| `search-weknora` IPC handler | 不再需要，由 MCP 脚本直调 API |
| `send-message` 中的 WeKnora 上下文拼接逻辑 | MCP 方案由 LLM 自主调用 |
| `useChat` 中的 `weknoraKbIds` 参数 | 改为 ChatView 内部状态 + 指令注入 |
| `undici` 依赖 | 移除未使用的 import |

## 保留的代码

| 保留项 | 原因 |
|--------|------|
| `list-weknora-kbs` IPC handler | 仍用于 UI 下拉框列出 KB |
| `weknoraUrl` / `weknoraApiKey` 配置项 | 用于 MCP 环境变量传递 |

## `extraResources` 配置

```json
"extraResources": [
  { "from": "resources/weknora-mcp.js", "to": "weknora-mcp.js" }
]
```

## 关键注意事项

1. **`command` 必须是 `Array<string>`**（字符串数组），不是字符串。与 SDK `McpLocalConfig` 类型一致
2. **权限键名格式为 `mcp__server__*`**，不是 `server_*`
3. **MCP 脚本必须响应 `tools/list` 请求**（标准协议），不能仅依赖 `tools/setup`
4. **`initialize` 握手必须处理**，否则 opencode 会等待超时
5. **`restartOpencode` 必须先 `stopHealthCheck()`**，防止旧检查干扰新服务器
6. 工具名注册为 `search`，opencode 自动拼接为 `weknora_search`，系统指令需对应
7. **KB 指令通过 SDK 的 `system` 参数传递**，不拼接到用户文本中。SDK 类型：`SessionPromptAsyncData.body.system?: string`
8. **`send-message` IPC 增加 `system?` 参数**，主进程透传给 `promptAsync`
9. **`webInfo` 同时控制 `websearch` + `webfetch`**，关闭后 LLM 无法进行网页搜索和 URL 抓取
10. **`SettingsDialog` 已移除互联网搜索开关**，工具栏 🌐 为唯一控制入口；`handleSave` 从最新 config 读 `webInfo` 防止覆盖

## 对话流保护（isStreaming 守卫）

### 问题

在单一会话架构中，会话通过 `key={activeId}` 切换（销毁重建）。如果正在等待流式响应时切换到其他会话，旧 ChatView 被销毁，流式数据丢失。

### 方案

新增 `onStreamingChange` prop，ChatView 在 `isLoading` 变化时通知父组件 `App`：

```tsx
// ChatView.tsx
const { isLoading } = useChat(...)

useEffect(() => {
  onStreamingChange?.(isLoading)
}, [isLoading])
```

`App` 将 `isStreaming` 传给 `SessionSidebar`：

```tsx
// App.tsx
const [isStreaming, setIsStreaming] = useState(false)

<ChatView onStreamingChange={setIsStreaming} />
<SessionSidebar disabled={isStreaming} />
```

切换/新建按钮在流式进行时置灰 + `opacity-50` + `cursor-not-allowed` + tooltip。

### 不采用多会话并发的原因

尝试过将 `useChat` 改为 `Map<sessionID, SessionState>` 结构 + `key={activeId}` 移除保持组件常驻，但引入了较多边缘场景 bug（handler 覆盖、内存数据被 SQLite 旧数据覆盖等）。当前单一会话 + 切换守卫是更稳健的选择。

### 问题

代码块中超长内容撑宽父容器，不换行且无横向滚动条。

### 根因

`<pre>` 的 `min-width: auto`（默认）使其不能小于 `<code>` 行内内容的宽度，导致 `<pre>` 被撑宽，`overflow-x: auto` 无从触发。外层 ScrollArea 的 `overflow: hidden` 进一步剪掉了滚动条渲染区域。

### 修复方案

不换行模式使用 Grid 容器强制 `<pre>` 收缩：

```tsx
{wordWrap ? (
  // 自动换行模式
  <pre className="p-4 text-sm whitespace-pre-wrap break-all bg-background">
    <code ... />
  </pre>
) : (
  // 不换行模式：Grid 容器 + overflow-x-auto 出横向滚动条
  <div className="overflow-x-auto" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)' }}>
    <pre className="p-4 text-sm whitespace-pre bg-background">
      <code ... />
    </pre>
  </div>
)}
```

`grid-template-columns: minmax(0, 1fr)` 是核心：列宽最小允许为 0，强制 `<pre>` 收缩到容器宽度。溢出由外层 `<div>` 的 `overflow-x: auto` 检测并出滚动条。

### 换行切换

代码块右上角增加 `↔` / `↩` 按钮，默认自动换行（`whitespace-pre-wrap break-all`），点击切为不换行+横向滚动条。

## 文件名变更

| 旧名 | 新名 | 说明 |
|------|------|------|
| `webSearch` | `webInfo` | 配置项重命名，语义更清晰：控制一切网络信息获取 |
| `互联网搜索`（标签） | 删除 | 工具栏只保留 🌐 图标 + 开关 |

## 文件变更

| 文件 | 操作 | 说明 |
|------|------|------|
| `resources/weknora-mcp.js` | **新建** | MCP 服务器脚本，实现完整协议（initialize / tools/list / tools/setup / tools/call） |
| `src/main/index.ts` | 修改 | `restartOpencode` 自动注册 `mcp.weknora`；添加 `stopHealthCheck()` + `reconnecting` 通知；删除 `search-weknora` IPC；保留 `list-weknora-kbs`；删除 WeKnora 拼接代码；`send-message` 透传 `system` 参数给 `promptAsync`；`webInfo` 同时控制 `websearch` + `webfetch` 工具 |
| `src/renderer/src/components/ChatView.tsx` | 修改 | KB 选择器改为**多选复选框下拉**（固定向上展开 + 刷新按钮）；`handleSend` 将 KB 指令提取为 `system` 参数传入，不再拼接到文本；工具栏互联网搜索按钮删文字留图标，`webSearch` → `webInfo`；新增 `onStreamingChange` prop 报告流式状态 |
| `src/renderer/src/hooks/useChat.ts` | 修改 | 移除 `weknoraKbIds` 参数；`sendMessage` 增加 `system?` 参数透传 |
| `src/renderer/src/App.tsx` | 修改 | 移除 WeKnora 状态管理；初始状态改为 `'reconnecting'`；新增 `isStreaming` 状态传递给 SessionSidebar 和 ChatView |
| `src/renderer/src/components/SessionSidebar.tsx` | 修改 | 新增 `disabled` prop，流式进行时禁切换和新建按钮 |
| `src/preload/index.ts` | 修改 | 移除 `searchWeknora`；`sendMessage` IPC 桥增加 `system?` 参数 |
| `src/preload/index.d.ts` | 修改 | 移除 `searchWeknora`；`sendMessage` 类型增加 `system?` |
| `src/renderer/src/components/MessageItem.tsx` | 修改 | CodeBlock 组件重写：移除外层 `overflow-hidden`；增加换行切换按钮（默认自动换行）；不换行模式用 Grid `minmax(0,1fr)` 强制容器收缩，修复超长代码撑宽无滚动条的问题 |
| `package.json` | 修改 | 新增 `extraResources` 配置包含 `weknora-mcp.js` |
| `src/main/configStore.ts` | 修改 | `webSearch` → `webInfo` 重命名，语义更清晰（控制一切网络信息获取） |
| `src/renderer/src/components/SettingsDialog.tsx` | 修改 | 移除互联网搜索开关 UI；`handleSave` 使用最新 config 的 `webInfo` 防止覆盖工具栏设置 |

## knowledge_chat 工具

### 背景

2026-06-23 新增 `knowledge_chat` 工具，基于 Weknora 知识图谱增强检索（图查询）的智能问答，与 `search`（精确检索原始文本）互补：

| 工具 | 用途 | 响应方式 | 适用场景 |
|------|------|---------|---------|
| `search` | 精确检索原始文本片段 | 同步 JSON | 查找原文、获取引用 |
| `knowledge_chat` | 图增强智能问答 | SSE 流 → JSON | 综合分析、多步推理、关联知识 |

### MCP 脚本修改

`resources/weknora-mcp.js` 注册第二个工具：

```js
{
  name: 'knowledge_chat',
  description: `基于知识库进行智能问答。会通过知识图谱增强检索（图查询），返回 JSON 格式的自然语言答案及引用来源。`,
  inputSchema: {
    properties: {
      query: { type: 'string', description: '用户问题' },
      kb_ids: { type: 'array', items: { type: 'string' }, description: '知识库 ID 列表（可选）' },
      agent_id: { type: 'string', description: 'Agent ID（可选）' },
    },
    required: ['query'],
  },
}
```

### SSE 流处理

`knowledge_chat` 调用 `POST /api/v1/knowledge-chat/{sessionId}`，返回 SSE 流。解析逻辑：

```
事件格式:
  event:message\n
  data:{"response_type":"thinking"|"answer"|"references"|"complete", "content":"...", "done":bool}\n\n

处理:
  references → 累积到 refs[]
  answer     → 逐 chunk 拼接到 answer
  thinking   → 忽略（非最终答案）
  complete   → 忽略
```

### SSE 解析修复

**问题**: `data:` 前缀可能带空格（`data: {json}`）或不带空格（`data:{json}`），取决于服务器实现。

**修复**（2026-06-23）：

| 行 | 改前 | 改后 |
|----|------|------|
| `startsWith` | `line.startsWith('data: ')` | `line.startsWith('data:')` |
| JSON 提取 | `line.slice(6)` | `line.slice(5).trim()` |

### 超时架构

**问题**: `knowledge_chat` 引入 LLM + SSE 后，耗时不定（数秒到数分钟）。原 120s 硬性 MCP 超时对 SSE 流不够灵活。

 **方案**: 双层超时（2026-06-23），后调整为 5 分钟：

```
┌─────────────────────────────────────┐
│ 外层（main/index.ts）               │
│ timeout: 移除（无限制）              │
│ 仅作用于 weknora MCP server         │
│ 其他 MCP 不受影响                   │
└──────────┬──────────────────────────┘
           │
┌──────────▼──────────────────────────┐
│ 内层（weknora-mcp.js）              │
│                                     │
│ search:                             │
│   fetch + AbortSignal.timeout(300s) │
│   单次请求硬超时                     │
│                                     │
│ knowledge_chat:                     │
│   Promise.race([                    │
│     reader.read(),                  │
│     idleTimeout(300s)               │
│   ])                                │
│   收到 data: 自动续期               │
│   300s 无数据 → 返回已有结果        │
└─────────────────────────────────────┘
```

**文件修改**：

| 文件 | 操作 |
|------|------|
| `src/main/index.ts:177` | 删除 `timeout: 120_000` |
| `resources/weknora-mcp.js` | `search` 的 fetch 加 `signal: AbortSignal.timeout(300000)` |
| `resources/weknora-mcp.js` | `knowledge_chat` SSE 循环改用 `Promise.race` idle timeout（300s） |

### Session 管理

`knowledge_chat` 调用前先通过 `POST /api/v1/sessions` 创建会话，标题为 `mcp-{timestamp}`。随时间推移会积累大量 mcp 会话。

#### curl 命令

```bash
# 查看所有会话
curl -s "${WEKNORA_URL}/api/v1/sessions" \
  -H "X-API-Key: ${WEKNORA_API_KEY}" | jq .

# 删除单个会话
curl -s -X DELETE "${WEKNORA_URL}/api/v1/sessions/${SESSION_ID}" \
  -H "X-API-Key: ${WEKNORA_API_KEY}"

# 批量删除 mcp 创建的会话（先列出再逐个删）
curl -s "${WEKNORA_URL}/api/v1/sessions" \
  -H "X-API-Key: ${WEKNORA_API_KEY}" | \
  jq -r '.data[] | select(.title | startswith("mcp-")) | .id' | \
  while read id; do
    curl -s -X DELETE "${WEKNORA_URL}/api/v1/sessions/$id" \
      -H "X-API-Key: ${WEKNORA_API_KEY}"
  done
```
