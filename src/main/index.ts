import { app, BrowserWindow, ipcMain, dialog, clipboard, protocol, net, shell } from 'electron'
import path from 'path'
import { loadSessions, saveSessionList, loadMessages, saveMessages, deleteSession as deleteStoredSession } from './sessionStore'
import type { SessionMeta, StoredMessage } from './sessionStore'
import { loadConfig, saveConfig } from './configStore'
import type { AppConfig } from './configStore'
import { initDatabase } from './db'
import { loadAgents, saveAgents, loadMcpServers, saveMcpServers, defaultTools } from './configStore'
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, statSync } from 'fs'
import yaml from 'js-yaml'

let mainWindow: BrowserWindow | null = null
let workspacePath: string

function getAppRoot(): string {
  if (app.isPackaged) {
    const exePath = process.env.APPIMAGE || app.getPath('exe')
    return path.dirname(exePath)
  }
  return path.join(__dirname, '..', '..')
}

function getWorkspaceStorePath(): string {
  const dir = path.join(app.getPath('userData'))
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return path.join(dir, 'workspace-path.txt')
}

function resolveWorkspace(): string {
  const arg = process.argv.find(a => a.startsWith('--cwd='))
  if (arg) return path.resolve(arg.split('=')[1])
  const storePath = getWorkspaceStorePath()
  try {
    const saved = readFileSync(storePath, 'utf-8').trim()
    if (saved && existsSync(saved)) return saved
  } catch {}
  const appRoot = getAppRoot()
  const defaultWs = path.join(appRoot, 'workspace')
  if (!existsSync(defaultWs)) mkdirSync(defaultWs, { recursive: true })
  return defaultWs
}

function saveWorkspacePath(p: string) {
  try { writeFileSync(getWorkspaceStorePath(), p, 'utf-8') } catch {}
}
let opencodeClient: any = null
let opencodeServer: any = null
let opencodeReady = false
let currentSessionId: string | null = null
const partTypes: Record<string, string> = {}

let directAbortController: AbortController | null = null

let healthCheckInterval: NodeJS.Timeout | null = null
let reconnectAttempts = 0
const MAX_RECONNECT_ATTEMPTS = 3

function stopHealthCheck() {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval)
    healthCheckInterval = null
  }
}

function startHealthCheck() {
  stopHealthCheck()
  reconnectAttempts = 0
  healthCheckInterval = setInterval(async () => {
    try {
      await opencodeClient.global.health()
      mainWindow?.webContents.send('connection-status', 'connected')
      reconnectAttempts = 0
    } catch {
      mainWindow?.webContents.send('connection-status', 'disconnected')
      stopHealthCheck()
      tryAutoReconnect()
    }
  }, 10000)
}

async function tryAutoReconnect() {
  while (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
    reconnectAttempts++
    mainWindow?.webContents.send('connection-status', 'reconnecting')
    try {
      const config = loadConfig()
      await restartOpencode(config)
      startHealthCheck()
      return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 3000))
    }
  }
  mainWindow?.webContents.send('connection-status', 'disconnected')
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1024,
    height: 720,
    icon: path.join(__dirname, '../../resources/icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => {})
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

async function restartOpencode(config: AppConfig) {
  stopHealthCheck()
  mainWindow?.webContents.send('connection-status', 'reconnecting')
  if (opencodeServer) {
    opencodeServer.close()
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  opencodeReady = false

  process.env.OPENCODE_ENABLE_EXA = '1'

  const providerConfig: Record<string, any> = {}
  for (const p of config.providers) {
    const modelCfg: any = { id: p.model, ...(p.modelCfg || {}) }
    if (providerConfig[p.name]) {
      providerConfig[p.name].models[p.model] = modelCfg
    } else {
      providerConfig[p.name] = {
        options: {
          apiKey: p.apiKey,
          ...(p.baseUrl ? { baseURL: p.baseUrl } : {}),
        },
        models: { [p.model]: modelCfg },
      }
    }
  }

  // 从 DB 读取 MCP 服务器（需先于 agent 构建）
  const mcpList = loadMcpServers()
  const mcpConfig: Record<string, any> = {}
  const mcpPermissions: Record<string, string> = {}
  for (const s of mcpList) {
    if (s.type === 'local') {
      mcpConfig[s.name] = { type: 'local', command: s.command, enabled: s.enabled }
    } else {
      mcpConfig[s.name] = { type: 'remote', url: s.url, enabled: s.enabled }
    }
    if (s.permission && s.permission !== 'allow') {
      mcpPermissions['mcp__' + s.name + '__*'] = s.permission
    }
  }

  // 自动注册 WeKnora MCP
  if (config.weknoraUrl && config.weknoraApiKey) {
    const mcpScriptPath = app.isPackaged
      ? path.join(process.resourcesPath, 'weknora-mcp.js')
      : path.join(__dirname, '..', '..', 'resources', 'weknora-mcp.js')
    mcpConfig.weknora = {
      type: 'local',
      command: ['node', mcpScriptPath],
      environment: {
        WEKNORA_URL: config.weknoraUrl,
        WEKNORA_API_KEY: config.weknoraApiKey,
      },
      enabled: true,
    }
    mcpPermissions['mcp__weknora__*'] = 'allow'
  }

  // 构建全局 permission 基础
  const globalSkillPerm = Object.keys(config.skillToggles).length > 0
    ? { '*': 'deny', ...Object.fromEntries(Object.entries(config.skillToggles).map(([k, v]) => [k, v ? 'allow' : 'deny'])) }
    : undefined

  const basePermission: Record<string, any> = {
    websearch: 'allow',
    webfetch: 'allow',
    read: 'allow',
    edit: 'allow',
    glob: 'allow',
    grep: 'allow',
    list: 'allow',
    external_directory: 'deny',
    ...mcpPermissions,
  }
  if (globalSkillPerm) basePermission.skill = globalSkillPerm

  // 从 DB 读取 agents 注册到 config
  const agentList = loadAgents()
  const agentConfig: Record<string, any> = {}
  for (const a of agentList) {
    const agentOverrides: Record<string, any> = {}
    const agentTools = { ...(a.tools || defaultTools()) }

    // 处理工具级权限（toolPermissions）
    if (a.toolPermissions) {
      for (const [tool, perm] of Object.entries(a.toolPermissions)) {
        if (perm === 'deny') {
          agentTools[tool] = false
        } else if (perm === 'ask' || perm === 'allow') {
          agentTools[tool] = true
          agentOverrides[tool] = perm
        }
      }
    }

    if (a.skillPermissions) {
      const skills: Record<string, string> = {}
      for (const [k, v] of Object.entries(a.skillPermissions)) {
        if (v !== 'inherit') skills[k] = v
      }
      if (Object.keys(skills).length > 0) agentOverrides.skill = skills
    }
    if (a.mcpPermissions) {
      for (const [k, v] of Object.entries(a.mcpPermissions)) {
        if (v !== 'inherit') agentOverrides['mcp__' + k + '__*'] = v
      }
    }
    agentConfig[a.id] = {
      prompt: a.prompt,
      tools: agentTools,
      ...(Object.keys(agentOverrides).length > 0 ? { permission: { ...basePermission, ...agentOverrides } } : {}),
    }
  }
  const { createOpencode } = await import('@opencode-ai/sdk/v2')
  const { client, server } = await createOpencode({
    port: 0,
    config: {
      model: `${config.activeProvider}/${config.activeModel}`,
      agent: agentConfig,
      skills: { paths: ['./skills'] },
      mcp: Object.keys(mcpConfig).length > 0 ? mcpConfig : undefined,
      permission: basePermission,
      provider: providerConfig,
    },
  })
  opencodeClient = client
  opencodeServer = server
  opencodeReady = true
  startHealthCheck()
  ;(async () => {
    try {
      await opencodeClient.global.health()
      mainWindow?.webContents.send('connection-status', 'connected')
    } catch {}
  })()
}

async function directApiCall(sessionId: string, text: string, system: string | undefined, parts: any[]) {
  const savedConfig = loadConfig()

  const providerCfg = savedConfig.providers.find(
    p => p.name === savedConfig.activeProvider && p.model === savedConfig.activeModel
  )
  if (!providerCfg) throw new Error('Provider 配置未找到')

  const agents = loadAgents()
  const activeAgent = agents.find(a => a.id === savedConfig.activeAgent)
  const systemMessages = [activeAgent?.prompt || '', system || ''].filter(Boolean)
  const systemText = systemMessages.length > 0 ? systemMessages.join('\n\n') : undefined

  const userContent: any[] = []
  const fileNames: string[] = []
  let hasText = false

  for (const part of parts || []) {
    if (part.type === 'text' && part.text) {
      userContent.push({ type: 'text', text: part.text })
      hasText = true
    } else if (part.type === 'file') {
      let filePath = part.url || ''
      if (filePath.startsWith('file://')) {
        filePath = filePath.slice(7)
        if (process.platform === 'win32' && filePath.startsWith('/')) {
          filePath = filePath.slice(1)
        }
      }

      if (!existsSync(filePath)) throw new Error(`文件不存在: ${filePath}`)

      const stat = statSync(filePath)
      if (stat.size > 17 * 1024 * 1024) throw new Error(`文件超过 17MB: ${filePath}`)

      const buffer = readFileSync(filePath)
      const ext = path.extname(filePath).toLowerCase().slice(1)
      const mimeMap: Record<string, string> = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
        gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
      }
      const mime = mimeMap[ext]
      if (!mime) throw new Error(`不支持的文件类型: .${ext}，仅支持图片(png/jpg/jpeg/gif/webp/bmp)`)

      const base64 = buffer.toString('base64')
      userContent.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } })
      fileNames.push(part.filename || path.basename(filePath))
    }
  }

  if (!hasText && userContent.length === 0) {
    userContent.push({ type: 'text', text: '' })
  }

  const messages: any[] = []
  if (systemText) messages.push({ role: 'system', content: systemText })
  messages.push({ role: 'user', content: userContent })

  const baseUrl = (providerCfg.baseUrl || '').replace(/\/+$/, '')
  const apiUrl = `${baseUrl}/chat/completions`

  const abortController = new AbortController()
  directAbortController = abortController
  const timeout = setTimeout(() => abortController.abort(), 3600000)

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${providerCfg.apiKey}`,
      },
      body: JSON.stringify({ model: providerCfg.model, messages, stream: true }),
      signal: abortController.signal,
    })

    if (!response.ok) {
      const errBody = await response.text()
      throw new Error(`API 请求失败 (${response.status}): ${errBody}`)
    }

    const reader = response.body?.getReader()
    if (!reader) throw new Error('响应流不可读')

    const decoder = new TextDecoder()
    let buf = ''
    let fullResponse = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data: ')) continue
        const data = trimmed.slice(6)
        if (data === '[DONE]') continue
        try {
          const parsed = JSON.parse(data)
          const delta = parsed.choices?.[0]?.delta?.content
          if (delta) {
            fullResponse += delta
            mainWindow?.webContents.send('stream-chunk', { delta, partType: 'text' })
          }
        } catch {}
      }
    }

    mainWindow?.webContents.send('stream-end')

    if (opencodeReady && opencodeClient) {
      try {
        const contextText = `# 用户请求
## 文本
${text || '(无文本)'}

## 附件
${fileNames.length > 0 ? fileNames.map(n => `- ${n}`).join('\n') : '(无附件)'}

# AI 响应
${fullResponse}`

        await opencodeClient.session.prompt({
          sessionID: sessionId,
          noReply: true,
          parts: [{ type: 'text', text: contextText }],
        })
      } catch (injectErr) {
        console.error('注入上下文失败:', injectErr)
      }
    }
  } finally {
    clearTimeout(timeout)
    directAbortController = null
  }
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'local-asset', privileges: { bypassCSP: true, stream: true } },
])

app.whenReady().then(async () => {
  protocol.handle('local-asset', (request) => {
    const filePath = decodeURIComponent(request.url.slice('local-asset://'.length))
    return net.fetch('file://' + filePath)
  })

  workspacePath = resolveWorkspace()
  process.chdir(workspacePath)
  await initDatabase()
  await createWindow()

  if (app.isPackaged) {
    const sep = process.platform === 'win32' ? ';' : ':'
    process.env.PATH = `${process.resourcesPath}${sep}${process.env.PATH}`
  }

  ipcMain.handle('reconnect-server', async () => {
    mainWindow?.webContents.send('connection-status', 'reconnecting')
    const config = loadConfig()
    await restartOpencode(config)
  })

  ipcMain.handle('get-workspace-path', () => workspacePath)

  ipcMain.handle('open-workspace-folder', async () => {
    if (workspacePath) {
      await shell.openPath(workspacePath)
    }
  })

  ipcMain.handle('open-external', async (_event, url: string) => {
    await shell.openExternal(url)
  })

  ipcMain.handle('set-workspace-path', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory'],
      title: '选择工作目录',
    })
    if (result.canceled || !result.filePaths.length) return { success: false }
    const newPath = result.filePaths[0]
    workspacePath = newPath
    saveWorkspacePath(newPath)
    process.chdir(workspacePath)
    await initDatabase()
    const config = loadConfig()
    await restartOpencode(config)
    return { success: true, path: newPath }
  })

  ipcMain.handle('load-agents', () => loadAgents())

  ipcMain.handle('save-agents', async (_event, agents: any[]) => {
    saveAgents(agents)
    await restartOpencode(loadConfig())
  })

  ipcMain.handle('load-mcp', () => loadMcpServers())

  ipcMain.handle('save-mcp', async (_event, servers: any[]) => {
    saveMcpServers(servers)
    await restartOpencode(loadConfig())
  })

  ipcMain.handle('scan-skills', () => {
    const skillsDir = path.join(process.cwd(), 'skills')
    if (!existsSync(skillsDir)) return []
    const skills: { name: string; description: string }[] = []
    for (const dir of readdirSync(skillsDir)) {
      const skillFile = path.join(skillsDir, dir, 'SKILL.md')
      if (!existsSync(skillFile)) continue
      const content = readFileSync(skillFile, 'utf-8')
      const match = content.match(/^---\n([\s\S]*?)\n---/)
      if (!match) continue
      const frontmatter = yaml.load(match[1]) as any
      if (frontmatter?.name && frontmatter?.description) {
        skills.push({ name: frontmatter.name, description: frontmatter.description })
      }
    }
    return skills
  })

  // WeKnora 知识库列表
  ipcMain.handle('list-weknora-kbs', async () => {
    const cfg = loadConfig()
    if (!cfg.weknoraUrl || !cfg.weknoraApiKey) return []
    try {
      const res = await fetch(`${cfg.weknoraUrl}/api/v1/knowledge-bases`, {
        headers: { 'X-API-Key': cfg.weknoraApiKey, 'Content-Type': 'application/json' },
      })
      if (!res.ok) return []
      const body = await res.json() as any
      return (body.data || []).map((kb: any) => ({ id: kb.id, name: kb.name }))
    } catch { return [] }
  })

  // 配置
  ipcMain.handle('get-config', () => loadConfig())

  ipcMain.handle('save-config', async (_event, config: AppConfig) => {
    saveConfig(config)
    await restartOpencode(config)
    return { success: true }
  })

  ipcMain.handle('save-config-field', async (_event, key: string, value: any) => {
    const cfg = loadConfig()
    ;(cfg as any)[key] = value
    saveConfig(cfg)
  })

  ipcMain.handle('open-file-picker', async (_event, opts?: { multiple?: boolean }) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile', ...(opts?.multiple ? ['multiSelections' as const] : [])],
      title: '选择文件',
    })
    if (result.canceled) return []
    return result.filePaths
  })

  ipcMain.handle('read-clipboard-image', async () => {
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    const buffer = image.toPNG()
    return { buffer: Array.from(buffer), width: image.getSize().width, height: image.getSize().height }
  })

  ipcMain.handle('list-providers', async () => {
    if (!opencodeReady) return { providers: [], models: [] }
    try {
      const res = await opencodeClient.provider.list()
      const providers = res.data?.all || []
      const models = providers.flatMap((p: any) =>
        Object.entries(p.models || {}).map(([id, m]: [string, any]) => ({
          id,
          providerID: p.id,
          name: m.name || id,
          variants: m.variants ? Object.keys(m.variants).map((k: string) => ({ id: k })) : [],
          capabilities: m.capabilities || {},
          cost: m.cost || [],
          status: m.status || 'active',
          enabled: true,
          limit: m.limit || { context: 4096, output: 4096 },
        }))
      )
      return { providers, models }
    } catch {
      return { providers: [], models: [] }
    }
  })

  // 会话管理
  ipcMain.handle('list-sessions', () => loadSessions())

  ipcMain.handle('create-session', async () => {
    if (!opencodeReady) throw new Error('opencode 未就绪')
    const session = await opencodeClient.session.create({ title: '新建对话' })
    const meta: SessionMeta = {
      id: session.data.id,
      title: '新建对话',
      createdAt: new Date().toISOString(),
    }
    const sessions = loadSessions()
    sessions.unshift(meta)
    saveSessionList(sessions)
    return meta
  })

  ipcMain.handle('switch-session', (_event, id: string) => {
    currentSessionId = id
    return loadMessages(id)
  })

  ipcMain.handle('delete-session', async (_event, id: string) => {
    if (!opencodeReady) throw new Error('opencode 未就绪')
    await opencodeClient.session.delete({ sessionID: id })
    deleteStoredSession(id)
    if (currentSessionId === id) currentSessionId = null
  })

  ipcMain.handle('update-session-title', async (_event, id: string, title: string) => {
    if (!opencodeReady) throw new Error('opencode 未就绪')
    await opencodeClient.session.update({ sessionID: id, title })
    const sessions = loadSessions()
    const session = sessions.find(s => s.id === id)
    if (session) {
      session.title = title
      saveSessionList(sessions)
    }
  })

  ipcMain.handle('save-messages', (_event, sessionId: string, messages: StoredMessage[]) => {
    saveMessages(sessionId, messages)
  })

  ipcMain.handle('abort-message', async () => {
    if (directAbortController) {
      directAbortController.abort()
      directAbortController = null
    }
    if (currentSessionId && opencodeReady) {
      try {
        await opencodeClient.session.abort({ sessionID: currentSessionId })
      } catch {}
    }
  })

  ipcMain.handle('reply-permission', async (_event, requestID: string, reply: 'once' | 'always' | 'reject') => {
    if (!opencodeReady) return
    try {
      await opencodeClient.permission.reply({ requestID, reply })
    } catch (err) {
      console.error('reply-permission error:', err)
    }
  })

  ipcMain.handle('reply-question', async (_event, id: string, text: string) => {
    if (!opencodeReady) return
    try {
      await opencodeClient.question.reply({ requestID: id, answers: [[text]] })
    } catch (err) {
      console.error('reply-question error:', err)
    }
  })

  ipcMain.handle('reject-question', async (_event, id: string) => {
    if (!opencodeReady) return
    try {
      await opencodeClient.question.reject({ requestID: id })
    } catch (err) {
      console.error('reject-question error:', err)
    }
  })

  // 发送消息
  ipcMain.handle('send-message', async (_event, text: string, sessionId: string, system?: string, parts?: any[]) => {
    if (!opencodeReady || !sessionId) {
      return { success: false, error: 'opencode 未就绪或缺少 sessionId' }
    }
    currentSessionId = sessionId
    Object.keys(partTypes).forEach(key => delete partTypes[key])
    try {
      const savedConfig = loadConfig()

      const providerCfg = savedConfig.providers.find(
        p => p.name === savedConfig.activeProvider && p.model === savedConfig.activeModel
      )
      const tc = providerCfg?.modelCfg?.tool_call
      const toolcall = tc === undefined ? true : tc !== false

      if (!toolcall) {
        const finalParts = parts && parts.length > 0 ? parts : [{ type: 'text', text }]
        ;(async () => {
          try {
            await directApiCall(sessionId, text, system, finalParts)
          } catch (err: any) {
            mainWindow?.webContents.send('stream-error', { message: err.message })
          }
        })()
        return { success: true }
      }

      const events = await opencodeClient.event.subscribe()

      const finalParts = parts && parts.length > 0 ? parts : [{ type: 'text', text }]

      const allAgents = loadAgents()
      const agentFallback = allAgents.some(a => a.id === savedConfig.activeAgent) ? savedConfig.activeAgent : 'build'

      await opencodeClient.session.promptAsync({
        sessionID: sessionId,
        agent: agentFallback,
        model: { providerID: savedConfig.activeProvider, modelID: savedConfig.activeModel },
        tools: { websearch: savedConfig.webInfo, webfetch: savedConfig.webInfo },
        ...(savedConfig.thinkingDepth ? { variant: savedConfig.thinkingDepth } : {}),
        ...(system ? { system } : {}),
        parts: finalParts,
      })

      const timeout = setTimeout(() => {
        mainWindow?.webContents.send('stream-error', { message: '响应超时（1h）' })
      }, 3600000)

      ;(async () => {
        try {
          for await (const event of events.stream) {
            if (event.type === 'message.part.updated') {
              const part = event.properties.part
              if (part && part.id) {
                partTypes[part.id] = part.type
                if (part.type === 'tool') {
                  mainWindow?.webContents.send('stream-tool', {
                    callID: part.id,
                    tool: part.tool,
                    status: part.state?.status,
                    input: part.state?.input,
                    output: part.state?.output || '',
                    title: part.state?.title,
                    error: part.state?.error,
                    progress: part.state?.progress,
                  })
                }
                if (part.type === 'file') {
                  mainWindow?.webContents.send('stream-file', {
                    id: part.id,
                    mediaType: part.mediaType || '',
                    filename: part.filename || '',
                    url: part.url || '',
                  })
                }
                if (part.type === 'subtask') {
                  mainWindow?.webContents.send('stream-subtask', {
                    id: part.id,
                    description: part.description || '',
                    agent: part.agent || '',
                    prompt: part.prompt || '',
                  })
                }
                if (part.type === 'step-finish') {
                  mainWindow?.webContents.send('stream-step-finish', {
                    id: part.id,
                    reason: part.reason || '',
                    cost: part.cost || 0,
                    tokens: part.tokens || {},
                  })
                }
              }
            }
            if (event.type === 'message.part.delta') {
              const delta = event.properties.delta
              const partID = event.properties.partID
              const partType = partTypes[partID] || 'text'
              if (delta) mainWindow?.webContents.send('stream-chunk', { delta, partType })
            }
            if (event.type === 'session.idle') {
              clearTimeout(timeout)
              mainWindow?.webContents.send('stream-end')
              break
            }
            if (event.type === 'session.error') {
              clearTimeout(timeout)
              mainWindow?.webContents.send('stream-error', event.properties.error)
              break
            }
            if (event.type === 'permission.asked') {
              const props = (event as any).properties
              mainWindow?.webContents.send('stream-permission', {
                id: props.id,
                action: props.permission,
                resources: props.patterns || [],
              })
            }
            if (event.type === 'question.asked') {
              const props = (event as any).properties
  mainWindow?.webContents.send('stream-question', {
                id: props.id,
                questions: props.questions || [],
              })
            }
            if (event.type === 'session.status') {
              mainWindow?.webContents.send('stream-session-status', (event as any).properties)
            }
          }
        } catch (streamErr: any) {
          clearTimeout(timeout)
          mainWindow?.webContents.send('stream-error', { message: streamErr.message })
        }
      })()

      return { success: true }
    } catch (err: any) {
      console.error('send-message error:', err)
      return { success: false, error: err.message }
    }
  })

  // 启动 opencode（读取已保存的配置）
  const savedConfig = loadConfig()
  await restartOpencode(savedConfig)

  app.on('before-quit', () => {
    stopHealthCheck()
    if (opencodeServer) opencodeServer.close()
  })
})

app.on('window-all-closed', () => {
  stopHealthCheck()
  if (opencodeServer) opencodeServer.close()
  if (process.platform !== 'darwin') app.quit()
})
