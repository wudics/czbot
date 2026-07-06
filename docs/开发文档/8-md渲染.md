# Markdown 渲染

## 目标

将 AI 正文回复中的 Markdown 语法渲染为可视化内容，包括标题、粗体、列表、表格、链接、代码块等。

## 技术选型

| 项目 | 选择 | 理由 |
|------|------|------|
| 渲染引擎 | **react-markdown** | React 原生组件，安全（不直接用 dangerouslySetInnerHTML），扩展性好 |
| GFM 扩展 | **remark-gfm** | 支持表格、任务列表、删除线等 GitHub 风格语法 |
| 代码高亮 | **highlight.js**（CodeBlock 组件内） | 已安装，与 rehype-highlight 冲突，由 CodeBlock 自行处理 |

## 渲染分工

| 区域 | 渲染方式 | 说明 |
|------|---------|------|
| 思考过程（`.reasoning`） | `whitespace-pre-wrap` 纯文本 | 不处理 markdown |
| 工具调用（`.tools`） | 纯文本 | 不处理 markdown |
| **正文回复（`.text`）** | **react-markdown** | 完整 markdown 渲染 |
| 加载动画（`...`） | 纯文本 | 不处理 markdown |

## 组件覆写

### 代码块

react-markdown 解析 ` ```language ` 为 `pre > code.language-xxx`。通过组件覆写拦截：

```tsx
pre({ children }) { return <>{children}</> }  // 去掉外层 pre
code({ className, children, ...props }) {
  const lang = className?.replace('language-', '')
  const code = String(children).replace(/\n$/, '')
  if (lang) return <CodeBlock language={lang} code={code} />
  if (code.includes('\n')) return <CodeBlock code={code} />  // 多行无标注 → CodeBlock
  return <code className="text-sm bg-muted/50 px-1 rounded">{children}</code>
}
```

- `pre` 直接返回 children，避免 react-markdown 的 `<pre>` 包裹
- `code` 检测到 `language-` 前缀时使用自定义 `CodeBlock` 组件（含复制按钮 + 语法高亮）
- 无语言标记的 `code` 渲染为行内代码样式

### CodeBlock 组件

```tsx
function CodeBlock({ language, code }: { language?: string; code: string }) {
  const html = useMemo(() => {
    if (language && hljs.getLanguage(language)) {
      return hljs.highlight(code, { language }).value
    }
    return hljs.highlightAuto(code).value
  }, [code, language])

  return (
    <div className="border rounded-md overflow-hidden">
      <div className="flex justify-between px-4 py-1.5 bg-muted text-xs">
        <span>{language || 'code'}</span>
        <button onClick={handleCopy}>{copied ? '已复制' : '📋'}</button>
      </div>
      <pre className="p-4 overflow-x-auto text-sm bg-background text-foreground">
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  )
}
```

### 其他组件

| 元素 | 渲染 |
|------|------|
| 链接 | `<a href={href} target="_blank" rel="noreferrer" className="underline">` |
| 表格 | `<div overflow-x-auto><table border-collapse>` → `<th>`/`<td>` 带边框 |
| 行内代码 | `<code className="text-sm bg-muted/50 px-1 rounded">` |

## 安装

```bash
npm install react-markdown remark-gfm
```

## 文件变更

| 文件 | 操作 | 说明 |
|------|------|------|
| `package.json` | 新增依赖 | `react-markdown` + `remark-gfm` |
| `src/renderer/src/lib/markdown.ts` | **删除** | 手写 `parseCodeBlocks` 不再需要 |
| `src/renderer/src/components/MessageItem.tsx` | 修改 | 正文改为 `<ReactMarkdown>` 渲染；`CodeBlock` 用 `hljs.highlight()` 生成高亮 HTML；`pre`/`code` 组件覆写 |

## 输入框（Shift+Enter 换行）

### InputBar.tsx

`<Input>` 替换为 `<textarea>`，支持多行输入：

```tsx
<textarea
  value={text}
  onChange={e => setText(e.target.value)}
  onInput={adjustHeight}
  onKeyDown={e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }}
  rows={1}
  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm min-h-0 max-h-[120px] resize-none overflow-y-auto"
/>
```

- **Enter** → 发送（`e.preventDefault()` 阻止换行）
- **Shift+Enter** → 浏览器默认行为 → 插入换行符
- `onInput` → 根据 `scrollHeight` 动态调整 textarea 高度
- 发送后高度重置为单行
- 容器 `items-end` 对齐，按钮保持底部不动

### 高度调整

```typescript
const adjustHeight = () => {
  const el = textareaRef.current
  if (!el) return
  el.style.height = 'auto'
  el.style.height = el.scrollHeight + 'px'
}
```

## 消息内容样式（message-content）

正文 markdown 渲染后各元素的间距和排版由 `globals.css` 中的 `.message-content` 规则统一控制。

### 背景

- `whitespace-pre-wrap` 导致 markdown 源文本的 `\n` 被保留，段落间多一个换行
- 解决：`ReactMarkdown` 外层包 `<div className="whitespace-normal">`，阻断空白继承
- `.message-content` 的 `margin` 统一用 `globals.css` 控制（不通过内联 `<style>`，避免 HMR 失效）

### CSS 规则（globals.css）

```css
.message-content p,
.message-content hr,
.message-content blockquote,
.message-content pre {
  margin: 0.25em 0;
}

.message-content h1 { font-size: 1.35em; font-weight: 700; margin: 0.6em 0 0.25em; }
.message-content h2 { font-size: 1.2em;  font-weight: 600; margin: 0.5em 0 0.2em; }
.message-content h3 { font-size: 1.1em;  font-weight: 600; margin: 0.4em 0 0.15em; }
.message-content h4,
.message-content h5,
.message-content h6 { font-size: 1em;   font-weight: 600; margin: 0.3em 0 0.1em; }

.message-content ul {
  list-style-type: disc;
  padding-inline-start: 1.5em;
  margin: 0;
}
.message-content ol {
  list-style-type: decimal;
  padding-inline-start: 1.5em;
  margin: 0;
}
.message-content li {
  margin: 0;
}
```

### 文件变更

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/renderer/src/globals.css` | 追加 | `.message-content` 系列规则 |
| `src/renderer/src/components/MessageItem.tsx` | 修改 | `ReactMarkdown` 外层包 `whitespace-normal` |
