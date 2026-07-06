import { useState, useEffect, useMemo, useRef } from 'react'
import hljs from 'highlight.js'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Message, ToolCall, ChatPart, ReasoningPart, ToolPart, SubtaskPart } from '../hooks/useChat'
import { formatTime } from '../lib/formatTime'
import { useAutoScroll } from '../hooks/useAutoScroll'

interface MessageItemProps {
  message: Message
  isStreaming?: boolean
  agents?: { id: string; name: string }[]
}

function CodeBlock({ language, code }: { language?: string; code: string }) {
  const [copied, setCopied] = useState(false)
  const [wordWrap, setWordWrap] = useState(true)

  useEffect(() => {
    if (copied) {
      const t = setTimeout(() => setCopied(false), 2000)
      return () => clearTimeout(t)
    }
  }, [copied])

  const html = useMemo(() => {
    if (language && hljs.getLanguage(language)) {
      return hljs.highlight(code, { language }).value
    }
    return hljs.highlightAuto(code).value
  }, [code, language])

  const handleCopy = () => {
    navigator.clipboard.writeText(code)
    setCopied(true)
  }

  return (
    <div className="relative group my-3 rounded-md border">
      <div className="flex items-center justify-between px-4 py-1.5 bg-muted text-xs text-muted-foreground rounded-t-md">
        <span>{language || 'code'}</span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setWordWrap(!wordWrap)}
            className={`hover:text-foreground transition-colors px-1 ${wordWrap ? 'text-foreground' : 'text-muted-foreground'}`}
            title={wordWrap ? '取消自动换行' : '自动换行'}
          >
            {wordWrap ? '↩' : '↔'}
          </button>
          <button
            onClick={handleCopy}
            className="hover:text-foreground transition-colors flex items-center gap-1"
          >
            {copied ? '已复制' : '📋'}
          </button>
        </div>
      </div>
      {wordWrap ? (
        <pre className="p-4 text-sm whitespace-pre-wrap break-all bg-background text-foreground">
          <code className={`language-${language || ''}`} dangerouslySetInnerHTML={{ __html: html }} />
        </pre>
      ) : (
        <div className="overflow-x-auto" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)' }}>
          <pre className="p-4 text-sm whitespace-pre bg-background text-foreground">
            <code className={`language-${language || ''}`} dangerouslySetInnerHTML={{ __html: html }} />
          </pre>
        </div>
      )}
    </div>
  )
}

function toolLabel(t: ToolCall): string {
  const input = t.input || {}
  switch (t.tool) {
    case 'web_search': case 'websearch': case 'search':
      return `🌐 搜索"${input.query || ''}"`
    case 'read': case 'file_read':
      return `📖 读取文件 ${input.filePath || ''}`
    case 'bash': case 'execute_command': case 'terminal':
      return `💻 ${(input.command || '').slice(0, 60)}${(input.command || '').length > 60 ? '...' : ''}`
    case 'edit': case 'write': case 'file_edit':
      return `✏️ 编辑文件 ${input.filePath || ''}`
    case 'glob':
      return `🔍 搜索模式 ${input.pattern || ''}`
    case 'grep':
      return `🔍 ${input.pattern || ''} in ${input.path || ''}`
    case 'task': case 'subtask':
      return `📋 ${input.description || ''}`
    case 'todowrite':
      return `📋 更新待办`
    default:
      return `🔧 ${t.tool}`
  }
}

interface WebSearchResult {
  title: string
  url: string
  highlights: string
}

function parseWebSearchResults(output: string): WebSearchResult[] {
  const blocks = output.split(/\n\n---\n\n/)
  return blocks.map(block => ({
    title: block.match(/^Title:\s*(.*)/m)?.[1] || '',
    url: block.match(/^URL:\s*(.*)/m)?.[1] || '',
    highlights: block.split(/^Highlights:\n/m)[1]?.trim() || '',
  })).filter(r => r.url)
}

function toolLabelRich(t: ToolCall): string {
  if (t.tool === 'websearch' && t.status === 'completed' && t.output) {
    const count = parseWebSearchResults(t.output).length
    return `🌐 搜索"${(t.input?.query || '')}" — 找到 ${count} 条结果`
  }
  if (t.tool === 'todowrite' && t.status === 'completed' && t.output) {
    const items = parseTodoItems(t.output)
    return `📋 更新待办 — ${items.length} 个待办`
  }
  return toolLabel(t)
}

function WebSearchResults({ results }: { results: WebSearchResult[] }) {
  return (
    <div className="not-italic text-xs mt-1 mb-2 space-y-2">
      {results.map((r, i) => (
        <div key={i} className="p-2 rounded bg-muted/50">
          <div className="flex items-center gap-1">
            <span className="flex-shrink-0 text-primary cursor-pointer" onClick={() => window.api.openExternal(r.url)}>🔗</span>
            <span
              className="text-primary cursor-pointer hover:underline truncate"
              title={r.url}
              onClick={() => window.api.openExternal(r.url)}
            >{r.title}</span>
          </div>
          {r.highlights && (
            <p className="text-muted-foreground mt-0.5 line-clamp-2">{r.highlights.split(/\[\.\.\.\]|\n\n/).find(s => s.trim()) || ''}</p>
          )}
        </div>
      ))}
    </div>
  )
}

interface TodoItemData {
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  priority: 'high' | 'medium' | 'low'
}

function parseTodoItems(output: string): TodoItemData[] {
  try {
    const data = JSON.parse(output)
    if (Array.isArray(data)) return data as TodoItemData[]
    if (data.todos && Array.isArray(data.todos)) return data.todos
  } catch {}
  return []
}

function TodoItems({ output }: { output: string }) {
  const items = parseTodoItems(output)
  const icon = (s: string) =>
    s === 'completed' || s === 'cancelled' ? '☑' : s === 'in_progress' ? '●' : '☐'
  return (
    <div className="text-xs mt-1 mb-2 space-y-0.5">
      {items.map((item, i) => (
        <div key={i} className="flex items-center gap-1.5 text-muted-foreground">
          <span className="flex-shrink-0">{icon(item.status)}</span>
          <span className={`truncate ${item.status === 'completed' || item.status === 'cancelled' ? 'line-through' : ''}`}>
            {item.content} - {item.priority}
          </span>
        </div>
      ))}
    </div>
  )
}

export default function MessageItem({ message, isStreaming, agents }: MessageItemProps) {
  const isUser = message.role === 'user'
  const [collapsed, setCollapsed] = useState(true)

  const toggleToolOutput = (callID: string) => {
    setExpandedTools(prev => {
      const next = new Set(prev)
      if (next.has(callID)) next.delete(callID); else next.add(callID)
      return next
    })
  }
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set())
  const thinkingRef = useRef<HTMLDivElement>(null)
  useAutoScroll(thinkingRef, [message.reasoning, message.tools, message.parts])

  useEffect(() => {
    if (isStreaming) setCollapsed(false)
  }, [isStreaming])

  useEffect(() => {
    if (!isStreaming && (message.reasoning || (message.tools && message.tools.length > 0) || (message.parts && message.parts.length > 0))) {
      setCollapsed(true)
    }
  }, [isStreaming])

  const fileIcon = (mime: string) => {
    if (mime.startsWith('image/')) return '🖼️'
    if (mime === 'application/pdf') return '📄'
    if (mime.includes('spreadsheet') || mime.includes('excel')) return '📊'
    if (mime.includes('presentation') || mime.includes('powerpoint')) return '📽️'
    if (mime.startsWith('text/') || mime === 'application/json') return '📝'
    if (mime.startsWith('audio/')) return '🎵'
    if (mime.startsWith('video/')) return '🎬'
    return '📎'
  }

  const isImageMime = (mime: string) => mime.startsWith('image/')

  const renderParts = () => {
    const parts = message.parts
    if (parts && parts.length > 0) {
      return parts.map((p, i) => {
        if (p.type === 'reasoning') {
          return <span key={i}>{(p as ReasoningPart).text}</span>
        }
        if (p.type === 'subtask') {
          const sp = p as SubtaskPart
          return (
            <div key={sp.id} className="not-italic mt-1 text-xs flex items-center gap-1 min-w-0">
              <span className="flex-shrink-0">📋</span>
              <span className="font-medium truncate min-w-0">{sp.description}</span>
              {sp.agent && (
                <span className="text-muted-foreground truncate">→ {agents?.find(a => a.id === sp.agent)?.name || sp.agent}</span>
              )}
            </div>
          )
        }
        const t = p as ToolPart
        return (
            <div key={t.callID}>
            <div className="not-italic mt-1 text-xs flex items-center gap-1 flex-nowrap min-w-0">
              <span className="flex-shrink-0">{t.status === 'running' || t.status === 'pending' ? '⏳' : t.status === 'completed' ? '✅' : t.status === 'error' ? '❌' : '🔧'}</span>
              <span className="font-medium truncate min-w-0">{toolLabelRich(t)}</span>
              {t.output && t.status === 'completed' && t.tool !== 'todowrite' && (
                <button
                  className="ml-auto flex-shrink-0 whitespace-nowrap text-muted-foreground/60 hover:text-muted-foreground text-[10px]"
                  onClick={() => toggleToolOutput(t.callID)}
                >
                  {expandedTools.has(t.callID) ? '收起结果' : '展开结果'}
                </button>
              )}
              {t.error && t.status === 'error' && (
                <button
                  className="ml-auto flex-shrink-0 whitespace-nowrap text-muted-foreground/60 hover:text-muted-foreground text-[10px]"
                  onClick={() => toggleToolOutput(t.callID)}
                >
                  {expandedTools.has(t.callID) ? '收起错误' : '展开错误'}
                </button>
              )}
            </div>
            {(t.status === 'running' || t.status === 'pending') && t.progress?.content && t.progress.content.length > 0 && (
              <div className="not-italic text-xs mt-1 mb-2 space-y-0.5">
                {t.progress.content.map((item, idx) => (
                  <div key={idx} className="text-muted-foreground/80 truncate">
                    {item.type === 'file' ? '📎 ' : ''}{item.text || item.uri || ''}
                  </div>
                ))}
              </div>
            )}
            {t.tool === 'todowrite' && t.status === 'completed' && t.output && (
              <TodoItems output={t.output} />
            )}
            {expandedTools.has(t.callID) && t.output && (t.tool === 'websearch'
              ? <WebSearchResults results={parseWebSearchResults(t.output)} />
              : <pre className="not-italic text-xs text-foreground/80 mt-1 mb-2 p-2 rounded bg-muted/50 whitespace-pre-wrap overflow-x-auto max-h-[20em] overflow-y-auto max-w-full">
                  {typeof t.output === 'string' ? t.output : JSON.stringify(t.output, null, 2)}
                </pre>
            )}
            {expandedTools.has(t.callID) && t.error && (
              <pre className="not-italic text-xs text-red-500 mt-1 mb-2 p-2 rounded bg-muted/50 whitespace-pre-wrap overflow-x-auto max-h-[20em] overflow-y-auto max-w-full">
                {t.error}
              </pre>
            )}
          </div>
        )
      })
    }
    return (
      <>
        {message.reasoning}
        {message.tools && message.tools.map((t, i) => (
          <div key={i}>
            <div className="not-italic mt-1 text-xs flex items-center gap-1 flex-nowrap min-w-0">
              <span className="flex-shrink-0">{t.status === 'running' || t.status === 'pending' ? '⏳' : t.status === 'completed' ? '✅' : t.status === 'error' ? '❌' : '🔧'}</span>
              <span className="font-medium truncate min-w-0">{toolLabelRich(t)}</span>
              {t.output && t.status === 'completed' && t.tool !== 'todowrite' && (
                <button
                  className="ml-auto flex-shrink-0 whitespace-nowrap text-muted-foreground/60 hover:text-muted-foreground text-[10px]"
                  onClick={() => toggleToolOutput(t.callID || String(i))}
                >
                  {expandedTools.has(t.callID || String(i)) ? '收起结果' : '展开结果'}
                </button>
              )}
              {t.error && t.status === 'error' && (
                <button
                  className="ml-auto flex-shrink-0 whitespace-nowrap text-muted-foreground/60 hover:text-muted-foreground text-[10px]"
                  onClick={() => toggleToolOutput(t.callID || String(i))}
                >
                  {expandedTools.has(t.callID || String(i)) ? '收起错误' : '展开错误'}
                </button>
              )}
            </div>
            {(t.status === 'running' || t.status === 'pending') && t.progress?.content && t.progress.content.length > 0 && (
              <div className="not-italic text-xs mt-1 mb-2 space-y-0.5">
                {t.progress.content.map((item, idx) => (
                  <div key={idx} className="text-muted-foreground/80 truncate">
                    {item.type === 'file' ? '📎 ' : ''}{item.text || item.uri || ''}
                  </div>
                ))}
              </div>
            )}
            {t.tool === 'todowrite' && t.status === 'completed' && t.output && (
              <TodoItems output={t.output} />
            )}
            {expandedTools.has(t.callID || String(i)) && t.output && (t.tool === 'websearch'
              ? <WebSearchResults results={parseWebSearchResults(t.output)} />
              : <pre className="not-italic text-xs text-foreground/80 mt-1 mb-2 p-2 rounded bg-muted/50 whitespace-pre-wrap overflow-x-auto max-h-[20em] overflow-y-auto max-w-full">
                  {typeof t.output === 'string' ? t.output : JSON.stringify(t.output, null, 2)}
                </pre>
            )}
            {expandedTools.has(t.callID || String(i)) && t.error && (
              <pre className="not-italic text-xs text-red-500 mt-1 mb-2 p-2 rounded bg-muted/50 whitespace-pre-wrap overflow-x-auto max-h-[20em] overflow-y-auto max-w-full">
                {t.error}
              </pre>
            )}
          </div>
        ))}
      </>
    )
  }

  return (
    <div id={`msg-${message.id}`} className={`mb-4 ${isUser ? 'mr-auto text-left' : ''}`}>
      {!isUser && (message.reasoning || (message.tools && message.tools.length > 0) || (message.parts && message.parts.length > 0)) && (
        <div>
          <button
            className="text-xs text-muted-foreground mb-1 hover:text-foreground flex items-center gap-1"
            onClick={() => setCollapsed(!collapsed)}
          >
            {collapsed ? '▶' : '▼'} 思考过程
          </button>
          {!collapsed && (
            <div ref={thinkingRef} className="text-sm text-muted-foreground italic mb-2 pl-2 border-l-2 border-muted whitespace-pre-wrap break-words overflow-y-auto overflow-x-hidden max-h-[15em] w-full">
              {renderParts()}
            </div>
          )}
        </div>
      )}
      <div
        className={`rounded-lg px-4 py-2 whitespace-pre-wrap break-words text-left message-content ${
          isUser
            ? 'inline-block max-w-[80%] bg-primary text-primary-foreground ml-auto'
            : 'bg-muted w-full min-w-0 max-w-full'
        }`}
      >
        {isUser && message.files && message.files.length > 0 && (
          <div className="mb-2 space-y-1">
            {message.files.map(f => (
              <div key={f.id} className="flex items-center gap-1.5 text-xs">
                <span>{fileIcon(f.mime)}</span>
                <span className="truncate max-w-[200px]">{f.filename}</span>
                {isImageMime(f.mime) && f.url && (
                  <img
                    src={f.url.replace('file://', 'local-asset://')}
                    alt={f.filename}
                    className="max-w-full max-h-[200px] rounded mt-1 object-contain"
                  />
                )}
              </div>
            ))}
          </div>
        )}
        {message.text ? (
          <div className="whitespace-normal">
            <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              pre({ children }) { return <>{children}</> },
              code({ className, children, ...props }) {
                const lang = className?.replace('language-', '')
                const code = String(children).replace(/\n$/, '')
                if (lang) return <CodeBlock language={lang} code={code} />
                if (code.includes('\n')) return <CodeBlock code={code} />
                return <code className="text-sm bg-muted/50 px-1 rounded" {...props}>{children}</code>
              },
              a({ href, children }) {
                return <a href={href} target="_blank" rel="noreferrer" className="underline">{children}</a>
              },
              table({ children }) {
                return <div className="overflow-x-auto my-2"><table className="border-collapse border border-border text-sm">{children}</table></div>
              },
              th({ children }) {
                return <th className="border border-border px-3 py-1.5 bg-muted font-medium">{children}</th>
              },
              td({ children }) {
                return <td className="border border-border px-3 py-1.5">{children}</td>
              },
            }}
          >
            {message.text}
          </ReactMarkdown>
          </div>
        ) : (
          !isUser ? (
            <span className="inline-flex gap-[1px]">
              <span className="animate-[blink_1.4s_infinite]">.</span>
              <span className="animate-[blink_1.4s_infinite_0.2s]">.</span>
              <span className="animate-[blink_1.4s_infinite_0.4s]">.</span>
            </span>
          ) : ''
        )}
        {!isUser && message.files && message.files.length > 0 && (
          <div className="mt-2 space-y-1">
            {message.files.map(f => (
              <div key={f.id} className="flex items-center gap-1.5 text-xs">
                <span>{fileIcon(f.mime)}</span>
                <span className="truncate max-w-[200px]">{f.filename}</span>
                {isImageMime(f.mime) && f.url && (
                  <img src={f.url} alt={f.filename} className="max-w-full max-h-[200px] rounded mt-1 object-contain" />
                )}
              </div>
            ))}
          </div>
        )}
        {message.createdAt && (
          <span className="block text-[10px] text-muted-foreground text-right mt-1">
            {!isUser && message.agentId && (
              <span className="inline-block bg-muted px-1 rounded mr-1">{agents?.find(a => a.id === message.agentId)?.name || message.agentId}</span>
            )}
            {formatTime(message.createdAt)}
          </span>
        )}
        {!isUser && message.stepFinish && (
          <span className="block text-[10px] text-muted-foreground/50 text-right">
            ⚡ {message.stepFinish.cost.toFixed(6)} | {message.stepFinish.tokens.input}→{message.stepFinish.tokens.output}
          </span>
        )}
      </div>
    </div>
  )
}

