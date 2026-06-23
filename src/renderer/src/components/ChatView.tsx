import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useChat } from '../hooks/useChat'
import { useAutoScroll } from '../hooks/useAutoScroll'
import MessageItem from './MessageItem'
import InputBar from './InputBar'
import PermissionCard from './PermissionCard'
import QuestionCard from './QuestionCard'

import { Button } from './ui/button'
import { Menu, Plus, RefreshCw } from 'lucide-react'
import { getVariantLabel, capabilityIcons } from '../lib/variants'

interface ChatViewProps {
  onOpenSidebar?: () => void
  sessionId: string | null
  onNewSession: () => void
  initialMessages?: any[]
  onAutoTitle?: (title: string) => void
  onStreamingChange?: (v: boolean) => void
  providers: { name: string; model: string; modelCfg?: Record<string, any> }[]
  activeProvider: string
  activeModel: string
  onModelChange: (provider: string, model: string) => void
  agents: { id: string; name: string }[]
  activeAgent: string
  onAgentChange: (id: string) => void
  weknoraConfigured: boolean
  availableProviders: any[]
  availableModels: any[]
  thinkingDepth: string
  onThinkingDepthChange: (variant: string) => void
}

export default function ChatView({ onOpenSidebar, sessionId, onNewSession, initialMessages = [], onAutoTitle, onStreamingChange, providers, activeProvider, activeModel, onModelChange, agents, activeAgent, onAgentChange, weknoraConfigured, availableProviders, availableModels, thinkingDepth, onThinkingDepthChange }: ChatViewProps) {
  const { messages, permissions, questions, isLoading, sessionStatus, sendMessage, abort, replyPermission, replyQuestion, rejectQuestion, loadMessages, setSessionId, clearMessages } = useChat(onAutoTitle)
  const scrollRef = useRef<HTMLDivElement>(null)
  const navRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ startY: number; scrollTop: number } | null>(null)
  const scrollBtnRef = useRef<HTMLButtonElement>(null)
  const [tooltip, setTooltip] = useState<{ text: string; x: number; y: number } | null>(null)

  const scrollToBottom = useCallback(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let near = true
    const check = () => {
      const newNear = el.scrollHeight - el.scrollTop - el.clientHeight < 300
      if (newNear !== near) {
        near = newNear
        if (scrollBtnRef.current) {
          scrollBtnRef.current.style.display = near ? 'none' : ''
        }
      }
    }
    el.addEventListener('scroll', check, { passive: true })
    return () => el.removeEventListener('scroll', check)
  }, [])

  const [webInfo, setWebSearch] = useState(false)
  const [weknoraKbs, setWeknoraKbs] = useState<{ id: string; name: string }[]>([])
  const [weknoraKbIds, setWeknoraKbIds] = useState<string[]>([])
  const [weknoraLoading, setWeknoraLoading] = useState(false)
  const [weknoraError, setWeknoraError] = useState(false)
  const [kbOpen, setKbOpen] = useState(false)
  const kbRef = useRef<HTMLDivElement>(null)

  const loadWeknoraKbs = useCallback(async () => {
    setWeknoraLoading(true)
    setWeknoraError(false)
    try {
      const list = await window.api.listWeknoraKbs()
      setWeknoraKbs(list)
    } catch {
      setWeknoraError(true)
    }
    setWeknoraLoading(false)
  }, [])

  useEffect(() => {
    window.api.getConfig().then(c => setWebSearch(c.webInfo))
  }, [])

  useEffect(() => {
    if (sessionId) {
      loadMessages(initialMessages)
      setSessionId(sessionId)
    } else {
      clearMessages()
      setSessionId(null)
    }
  }, [sessionId])

  useAutoScroll(scrollRef, [messages])

  useEffect(() => {
    if (isLoading) {
      scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight)
    }
  }, [isLoading])

  useEffect(() => {
    onStreamingChange?.(isLoading)
  }, [isLoading])

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (kbRef.current && !kbRef.current.contains(e.target as Node)) {
        setKbOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const opencodeProvider = useMemo(() => {
    if (!Array.isArray(availableProviders)) return undefined
    return availableProviders.find((p: any) => p.id === 'opencode')
  }, [availableProviders])

  const zenModels = useMemo(() =>
    opencodeProvider && Array.isArray(availableModels)
      ? availableModels.filter((m: any) => m.providerID === 'opencode')
      : [],
    [opencodeProvider, availableModels]
  )

  const currentModelInfo = useMemo(() =>
    Array.isArray(availableModels)
      ? availableModels.find((m: any) => m.providerID === activeProvider && m.id === activeModel) || null
      : null,
    [availableModels, activeProvider, activeModel]
  )

  const currentModelVariants = useMemo(() => {
    const currentProviderCfg = providers.find(p => p.name === activeProvider && p.model === activeModel)
    const cfgVariants = currentProviderCfg?.modelCfg?.variants
    if (cfgVariants && typeof cfgVariants === 'object') {
      return Object.keys(cfgVariants).map(k => ({ id: k }))
    }
    return currentModelInfo?.variants || []
  }, [providers, activeProvider, activeModel, currentModelInfo])

  const toggleKb = (id: string) => {
    setWeknoraKbIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    )
  }

  const handleSend = useCallback((text: string, files?: string[]) => {
    let system = ''
    if (weknoraKbIds.length > 0) {
      const names = weknoraKbs.filter(k => weknoraKbIds.includes(k.id)).map(k => k.name).join('、')
      const ids = weknoraKbIds.join(', ')
      system = `用户已选择以下知识库：${names}（ID: ${ids}）
如需精确搜索原始文本块，使用 search 工具；
如需智能问答（含知识图谱增强），使用 knowledge_chat 工具。`
    }
    sendMessage(text, system || undefined, files, activeAgent)
  }, [weknoraKbIds, weknoraKbs, activeAgent, sendMessage])

  const toggleSearch = () => {
    const next = !webInfo
    setWebSearch(next)
    window.api.saveConfigField('webInfo', next)
  }

  const kbLabel = weknoraKbIds.length === 0 ? '关闭' : `📚 ${weknoraKbIds.length}个`

  if (!sessionId) {
    return (
      <div className="flex-1 flex flex-col min-h-0 relative">
        <div className="flex items-center p-2 md:hidden">
          <Button variant="ghost" size="sm" onClick={onOpenSidebar}>
            <Menu className="h-5 w-5" />
          </Button>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-4">
          <p>选择一个对话或创建新对话</p>
          <Button variant="default" onClick={onNewSession}>
            <Plus className="h-4 w-4 mr-2" />
            新建对话
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col max-w-3xl mx-auto w-full p-4 gap-4 min-h-0 overflow-hidden">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" className="md:hidden" onClick={onOpenSidebar}>
          <Menu className="h-5 w-5" />
        </Button>
        <div className="flex-1" />
      </div>
      <div className="flex-1 min-h-0 w-full flex gap-1 relative">
        <nav
          ref={navRef}
          className="flex flex-col items-center pt-3 gap-3 w-6 flex-shrink-0 overflow-y-auto cursor-grab active:cursor-grabbing [&::-webkit-scrollbar]:hidden [scrollbar-width:none] self-center max-h-[40%]"
          onMouseDown={e => {
            dragRef.current = { startY: e.clientY, scrollTop: navRef.current!.scrollTop }
          }}
          onMouseMove={e => {
            if (!dragRef.current) return
            const delta = e.clientY - dragRef.current.startY
            navRef.current!.scrollTop = dragRef.current.scrollTop - delta
          }}
          onMouseUp={() => { dragRef.current = null }}
          onMouseLeave={() => { dragRef.current = null }}
        >
          {messages.filter(m => m.role === 'user').map(msg => (
            <span
              key={msg.id}
              className="flex-shrink-0 w-2 h-2 rounded-full bg-muted-foreground/30 hover:bg-muted-foreground transition-colors cursor-pointer"
              onClick={() => document.getElementById(`msg-${msg.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              onMouseEnter={e => setTooltip({ text: msg.text, x: e.clientX + 8, y: e.clientY })}
              onMouseMove={e => setTooltip(t => t ? { ...t, x: e.clientX + 8, y: e.clientY } : null)}
              onMouseLeave={() => setTooltip(null)}
            />
          ))}
        </nav>
        <div className="flex-1 h-full border rounded-lg overflow-y-auto min-w-0" ref={scrollRef}>
          <div className="p-4">
            {messages.length === 0 && (
              <p className="text-center text-muted-foreground mt-20">
                输入消息开始对话
              </p>
            )}
            {messages.map(msg => (
              <MessageItem key={msg.id} message={msg} isStreaming={isLoading} agents={agents} />
            ))}
          </div>
        </div>
        <button
            ref={scrollBtnRef}
            style={{ display: 'none' }}
            onClick={scrollToBottom}
            className="absolute bottom-3 right-3 z-10 bg-primary text-primary-foreground rounded-full w-8 h-8 flex items-center justify-center shadow-md hover:opacity-90 transition-opacity text-sm"
          >
            ↓
          </button>
      </div>
      {sessionStatus && sessionStatus.type !== 'idle' && (
        <div className="flex items-center gap-2 px-3 py-1.5 text-xs border rounded-md bg-muted/50 text-muted-foreground mb-2">
          {sessionStatus.type === 'busy' && (
            <><span className="animate-pulse">⚡</span> 模型思考中...</>
          )}
          {sessionStatus.type === 'retry' && (
            <><span>⚠️</span> 重试中 ({sessionStatus.attempt}/{sessionStatus.next}){sessionStatus.message && <span className="ml-1 text-[11px]">— {sessionStatus.message}</span>}</>
          )}
        </div>
      )}
      {questions.map(q => (
        <QuestionCard key={q.id} id={q.id} questions={q.questions} onReply={replyQuestion} onReject={rejectQuestion} />
      ))}
      {permissions.map(p => (
        <PermissionCard key={p.id} id={p.id} action={p.action} resources={p.resources} onReply={replyPermission} />
      ))}
      <div className="flex items-center gap-2 px-1 flex-wrap">
        <span className="text-xs text-muted-foreground">🧑</span>
        <select
          value={activeAgent}
          onChange={e => onAgentChange(e.target.value)}
          className="text-xs bg-transparent border border-input rounded px-1.5 py-1 text-muted-foreground hover:text-foreground focus:outline-none focus:ring-1 focus:ring-ring cursor-pointer max-w-[120px]"
        >
          {agents.map(a => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
        {weknoraConfigured && (
          <div ref={kbRef} className="relative">
            <button
              onClick={() => { if (!weknoraKbs.length && !weknoraLoading) loadWeknoraKbs(); setKbOpen(!kbOpen) }}
              className="text-xs bg-transparent border border-input rounded px-1.5 py-1 text-muted-foreground hover:text-foreground focus:outline-none focus:ring-1 focus:ring-ring cursor-pointer"
            >
              {weknoraError ? '⚠ 重试' : kbLabel}
            </button>
            {kbOpen && (
              <div className="absolute bottom-full mb-1 left-0 bg-white border rounded-md shadow-lg z-50 min-w-[180px] max-h-[260px] overflow-y-auto p-1">
                {weknoraLoading ? (
                  <div className="px-2 py-1 text-xs text-muted-foreground">加载中...</div>
                ) : weknoraError ? (
                  <div className="px-2 py-1 text-xs text-red-500">加载失败</div>
                ) : weknoraKbs.length > 0 ? (
                  <>
                    {weknoraKbs.map(kb => (
                      <label key={kb.id} className="flex items-center gap-2 px-2 py-1 text-xs hover:bg-accent rounded cursor-pointer">
                        <input
                          type="checkbox"
                          checked={weknoraKbIds.includes(kb.id)}
                          onChange={() => toggleKb(kb.id)}
                          className="h-3.5 w-3.5"
                        />
                        {kb.name}
                      </label>
                    ))}
                    <div className="border-t mt-1 pt-1">
                      <button
                        onClick={() => { setWeknoraKbIds([]); setKbOpen(false) }}
                        className="w-full text-left px-2 py-1 text-xs text-muted-foreground hover:bg-accent rounded"
                      >
                        清除选择
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="px-2 py-1 text-xs text-muted-foreground">无可用知识库</div>
                )}
                <div className="border-t mt-1 pt-1">
                  <button
                    onClick={(e) => { e.stopPropagation(); loadWeknoraKbs() }}
                    className="w-full flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:bg-accent rounded"
                  >
                    <RefreshCw className="h-3 w-3" />
                    刷新
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        <button
          onClick={toggleSearch}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          title={webInfo ? '网络搜索已开启' : '网络搜索已关闭'}
        >
          <span className="text-sm">🌐</span>
          <span className={`inline-block h-4 w-8 rounded-full transition-colors ${webInfo ? 'bg-primary' : 'bg-input'}`}>
            <span className={`block h-4 w-4 rounded-full bg-white dark:bg-background transition-all ${webInfo ? 'ml-4' : 'ml-0'}`} />
          </span>
        </button>
        <div className="ml-auto flex items-center gap-1">
          <span className="text-xs text-muted-foreground">🤖</span>
          <select
            value={`${activeProvider}/${activeModel}`}
            onChange={e => {
              const [p, ...m] = e.target.value.split('/')
              onModelChange(p, m.join('/'))
            }}
            className="text-xs bg-transparent border border-input rounded px-1.5 py-1 text-muted-foreground hover:text-foreground focus:outline-none focus:ring-1 focus:ring-ring cursor-pointer max-w-[200px]"
          >
            {providers.length > 0 && (
              <optgroup label="自定义配置">
                {providers.map(p => (
                  <option key={`${p.name}/${p.model}`} value={`${p.name}/${p.model}`}>
                    {p.name}/{p.model}
                  </option>
                ))}
              </optgroup>
            )}
            {zenModels.length > 0 && (
              <optgroup label="OpenCode Zen">
                {zenModels.map((m: any) => (
                  <option key={`opencode/${m.id}`} value={`opencode/${m.id}`}>
                    {m.name}{capabilityIcons(m.capabilities)}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          {currentModelVariants.length > 0 && (
            <>
              <span className="text-xs text-muted-foreground">🧠</span>
              <select
                value={thinkingDepth}
                onChange={e => onThinkingDepthChange(e.target.value)}
                className="text-xs bg-transparent border border-input rounded px-1.5 py-1 text-muted-foreground hover:text-foreground focus:outline-none focus:ring-1 focus:ring-ring cursor-pointer max-w-[120px]"
              >
                {currentModelVariants.map((v: any) => (
                  <option key={v.id} value={v.id}>
                    {v.label || getVariantLabel(activeProvider, v.id)}
                  </option>
                ))}
              </select>
            </>
          )}
        </div>
      </div>
      <InputBar onSend={handleSend} disabled={isLoading} onStop={abort} />
      {tooltip && (
        <div
          className="fixed z-50 text-xs text-gray-900 bg-white border rounded-md px-2.5 py-1.5 shadow-md pointer-events-none max-w-[260px] truncate"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          {tooltip.text}
        </div>
      )}
    </div>
  )
}
