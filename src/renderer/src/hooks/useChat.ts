import { useState, useCallback, useRef } from 'react'

// 模块级，跨 ChatView 实例持久化
const sessionScopedAlways = new Map<string, Set<string>>()

function friendlyError(err: any): string {
  const data = err?.data || err
  const msg = (data?.message || data?.error || '').toString()
  const status = data?.statusCode || 0

  if (status === 401 || status === 403 || msg.includes('Authorization') || msg.includes('API key') || msg.includes('apiKey')) {
    return 'API Key 未配置或无效，请在设置中检查 Provider 的 API Key 配置'
  }
  if (status === 400 && msg.includes('Content Exists Risk')) {
    return '请求被内容安全策略拦截，请换个方式描述问题'
  }
  if (status === 429 || msg.includes('rate limit') || msg.includes('quota') || msg.includes('Rate limit')) {
    return '请求频率过高或额度已用完，请稍后再试'
  }
  return JSON.stringify(err)
}

export interface ToolCall {
  callID: string
  tool: string
  status: string
  input: any
  output?: string
  title?: string
  error?: string
  progress?: { structured?: Record<string, any>; content?: { type: string; text?: string; uri?: string }[] }
}

export interface ReasoningPart {
  type: 'reasoning'
  text: string
}

export interface ToolPart {
  type: 'tool'
  callID: string
  tool: string
  status: string
  input: any
  output?: string
  title?: string
  error?: string
  progress?: { structured?: Record<string, any>; content?: { type: string; text?: string; uri?: string }[] }
}

export interface SubtaskPart {
  type: 'subtask'
  id: string
  description: string
  agent: string
  prompt: string
}

export interface StepFinishInfo {
  reason: string
  cost: number
  tokens: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
}

export type ChatPart = ReasoningPart | ToolPart | SubtaskPart

export interface PermissionPrompt {
  id: string
  action: string
  resources: string[]
}

export interface QuestionInfo {
  question: string
  header: string
  options: { label: string; description: string }[]
  custom?: boolean
  multiple?: boolean
}

export interface QuestionPrompt {
  id: string
  questions: QuestionInfo[]
}

export interface SessionStatusInfo {
  type: 'busy' | 'idle' | 'retry'
  attempt?: number
  message?: string
  next?: number
}

export interface Message {
  id: string
  role: 'user' | 'assistant'
  text: string
  files?: { id: string; filename: string; mime: string; url: string }[]
  reasoning?: string
  tools?: ToolCall[]
  parts?: ChatPart[]
  agentId?: string
  stepFinish?: StepFinishInfo
  createdAt: string
}

export function useChat(onAutoTitle?: (title: string) => void) {
  const [messages, setMessages] = useState<Message[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [permissions, setPermissions] = useState<PermissionPrompt[]>([])
  const [questions, setQuestions] = useState<QuestionPrompt[]>([])
  const [sessionStatus, setSessionStatus] = useState<SessionStatusInfo | null>(null)
  const currentMsgId = useRef<string | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const messagesRef = useRef<Message[]>([])
  const permissionsRef = useRef<PermissionPrompt[]>([])
  const questionsRef = useRef<QuestionPrompt[]>([])

  const loadMessages = useCallback((msgs: Message[]) => {
    setMessages(msgs)
    messagesRef.current = msgs
  }, [])

  const setSessionId = useCallback((id: string | null) => {
    sessionIdRef.current = id
  }, [])

  const saveToStorage = useCallback(() => {
    const sid = sessionIdRef.current
    if (!sid) return
    const stored = messagesRef.current.map(m => ({
      id: m.id,
      role: m.role,
      text: m.text,
      files: m.files,
      reasoning: m.reasoning,
      tools: m.tools,
      parts: m.parts,
      agent: m.agentId,
      stepFinish: m.stepFinish,
      createdAt: new Date().toISOString(),
    }))
    window.api.saveMessages(sid, stored)
  }, [])

  function filePathToURI(absPath: string): string {
    if (absPath.startsWith('/')) {
      return 'file://' + absPath
    }
    return 'file:///' + absPath.replace(/\\/g, '/')
  }

  function mimeFromFilename(name: string): string {
    const ext = name.split('.').pop()?.toLowerCase()
    const map: Record<string, string> = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
      pdf: 'application/pdf',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      doc: 'application/msword',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      xls: 'application/vnd.ms-excel',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      ppt: 'application/vnd.ms-powerpoint',
      txt: 'text/plain', html: 'text/html', htm: 'text/html', md: 'text/markdown', json: 'application/json', csv: 'text/csv', xml: 'text/xml',
      mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
      mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    }
    return map[ext || ''] || 'application/octet-stream'
  }

  const sendMessage = useCallback(async (text: string, system?: string, files?: string[], agentId?: string) => {
    const sid = sessionIdRef.current
    if (!sid) return

    setIsLoading(true)

    const now = new Date().toISOString()
    const userFileMetas = files?.map(p => {
      const name = p.split('/').pop() || p
      return {
        id: (Date.now() + Math.random()).toString(),
        filename: name,
        mime: mimeFromFilename(name),
        url: filePathToURI(p),
      }
    })
    const userMsg: Message = { id: Date.now().toString(), role: 'user', text, files: userFileMetas, agentId, createdAt: now }
    const assistantMsg: Message = { id: (Date.now() + 1).toString(), role: 'assistant', text: '', reasoning: '', tools: [], parts: [], agentId, createdAt: now }
    currentMsgId.current = assistantMsg.id

    setMessages(prev => {
      const next = [...prev, userMsg, assistantMsg]
      messagesRef.current = next
      return next
    })

    window.api.onStream(({ delta, partType }) => {
      setMessages(prev => {
        const next = prev.map(m => {
          if (m.id !== currentMsgId.current) return m
          if (partType !== 'reasoning') return { ...m, text: m.text + delta }
          const newReasoning = (m.reasoning || '') + delta
          const parts = m.parts ? [...m.parts] : []
          const last = parts[parts.length - 1]
          if (last && last.type === 'reasoning') {
            parts[parts.length - 1] = { ...last, text: last.text + delta }
          } else {
            parts.push({ type: 'reasoning', text: delta })
          }
          return { ...m, reasoning: newReasoning, parts }
        })
        messagesRef.current = next
        return next
      })
    })

    window.api.onTool((data) => {
      setMessages(prev => {
        const next = prev.map(m => {
          if (m.id !== currentMsgId.current) return m
          const tools = m.tools ? [...m.tools] : []
          const existing = tools.findIndex(t => t.callID === data.callID)
          if (existing >= 0) {
            tools[existing] = data
          } else {
            tools.push(data)
          }
          const parts = m.parts ? [...m.parts] : []
          const partIdx = parts.findIndex(p => p.type === 'tool' && (p as ToolPart).callID === data.callID)
          if (partIdx >= 0) {
            Object.assign(parts[partIdx], data)
          } else {
            parts.push({ type: 'tool', ...data })
          }
          return { ...m, tools, parts }
        })
        messagesRef.current = next
        return next
      })
    })

    window.api.onFile((data) => {
      setMessages(prev => {
        const next = prev.map(m => {
          if (m.id !== currentMsgId.current) return m
          const files = m.files ? [...m.files] : []
          files.push({
            id: data.id,
            filename: data.filename || 'file',
            mime: data.mediaType || 'application/octet-stream',
            url: data.url,
          })
          return { ...m, files }
        })
        messagesRef.current = next
        return next
      })
    })

    window.api.onSubtask((data) => {
      setMessages(prev => {
        const next = prev.map(m => {
          if (m.id !== currentMsgId.current) return m
          const parts = m.parts ? [...m.parts] : []
          const idx = parts.findIndex(p => p.type === 'subtask' && (p as SubtaskPart).id === data.id)
          if (idx >= 0) {
            parts[idx] = { type: 'subtask', ...data }
          } else {
            parts.push({ type: 'subtask', ...data })
          }
          return { ...m, parts }
        })
        messagesRef.current = next
        return next
      })
    })

    window.api.onStepFinish((data) => {
      setMessages(prev => {
        const next = prev.map(m => {
          if (m.id !== currentMsgId.current) return m
          return { ...m, stepFinish: { reason: data.reason, cost: data.cost, tokens: data.tokens } }
        })
        messagesRef.current = next
        return next
      })
    })

    window.api.onEnd(() => {
      setIsLoading(false)
      setSessionStatus({ type: 'idle' })
      saveToStorage()
      if (onAutoTitle) {
        const firstUserMsg = messagesRef.current.find(m => m.role === 'user')
        if (firstUserMsg && firstUserMsg.text) {
          onAutoTitle(firstUserMsg.text.slice(0, 30))
        }
      }
    })

    window.api.onError((error) => {
      setMessages(prev =>
        prev.map(m =>
          m.id === currentMsgId.current
            ? { ...m, text: `错误: ${friendlyError(error)}` }
            : m
        )
      )
      setIsLoading(false)
      setSessionStatus({ type: 'idle' })
    })

    window.api.onPermission((data) => {
      const sid = sessionIdRef.current
      const resPattern = data.resources[0] || '*'
      const key = `${data.action}:${resPattern}`
      if (sid && sessionScopedAlways.get(sid)?.has(key)) {
        window.api.replyPermission(data.id, 'once')
        return
      }
      setPermissions(prev => {
        const next = [...prev, { id: data.id, action: data.action, resources: data.resources }]
        permissionsRef.current = next
        return next
      })
    })

    window.api.onQuestion((data) => {
      setQuestions(prev => {
        const next = [...prev, { id: data.id, questions: data.questions }]
        questionsRef.current = next
        return next
      })
    })

    window.api.onSessionStatus((data) => {
      setSessionStatus(data.status as SessionStatusInfo)
    })

    const parts: any[] = []
    if (text) parts.push({ type: 'text', text })
    if (files && files.length > 0) {
      for (const p of files) {
        const name = p.split('/').pop() || p
        parts.push({
          type: 'file',
          mime: mimeFromFilename(name),
          filename: name,
          url: filePathToURI(p),
        })
      }
    }

    const result = await window.api.sendMessage(text, sid, system, parts)
    if (!result.success) {
      setMessages(prev =>
        prev.map(m =>
          m.id === currentMsgId.current
            ? { ...m, text: `启动失败: ${result.error}` }
            : m
        )
      )
      setIsLoading(false)
    }
  }, [saveToStorage])

  const abort = useCallback(() => {
    window.api.abortMessage()
  }, [])

  const replyPermission = useCallback((id: string, reply: 'once' | 'always' | 'reject') => {
    const perm = permissionsRef.current.find(p => p.id === id)
    if (reply === 'always' && perm) {
      const sid = sessionIdRef.current
      if (sid) {
        let set = sessionScopedAlways.get(sid)
        if (!set) {
          set = new Set()
          sessionScopedAlways.set(sid, set)
        }
        const resources = perm.resources.length > 0 ? perm.resources : ['*']
        for (const r of resources) {
          set.add(`${perm.action}:${r}`)
        }
      }
    }
    window.api.replyPermission(id, reply === 'always' ? 'once' : reply)
    setPermissions(prev => prev.filter(p => p.id !== id))
    permissionsRef.current = permissionsRef.current.filter(p => p.id !== id)
  }, [])

  const replyQuestion = useCallback((id: string, text: string) => {
    window.api.replyQuestion(id, text)
    setQuestions(prev => prev.filter(q => q.id !== id))
    questionsRef.current = questionsRef.current.filter(q => q.id !== id)
  }, [])

  const rejectQuestion = useCallback((id: string) => {
    window.api.rejectQuestion(id)
    setQuestions(prev => prev.filter(q => q.id !== id))
    questionsRef.current = questionsRef.current.filter(q => q.id !== id)
  }, [])

  const clearMessages = useCallback(() => {
    setMessages([])
    messagesRef.current = []
    permissionsRef.current = []
    setPermissions([])
    questionsRef.current = []
    setQuestions([])
    setSessionStatus(null)
    const sid = sessionIdRef.current
    if (sid) sessionScopedAlways.delete(sid)
  }, [])

  return { messages, permissions, questions, isLoading, sessionStatus, sendMessage, abort, replyPermission, replyQuestion, rejectQuestion, loadMessages, setSessionId, clearMessages }
}
