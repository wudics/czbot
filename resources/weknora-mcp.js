#!/usr/bin/env node
const readline = require('readline')
const crypto = require('crypto')
const rl = readline.createInterface({ input: process.stdin })

const WEKNORA_URL = process.env.WEKNORA_URL
const WEKNORA_API_KEY = process.env.WEKNORA_API_KEY

function sendMsg(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function itemToResult(item) {
  return {
    id: item.id || null,
    content: item.content || '',
    filename: item.knowledge_filename || null,
    title: item.knowledge_title || null,
    source_type: item.knowledge_source || null,
    chunk_type: item.chunk_type || null,
    chunk_index: item.chunk_index ?? null,
    offset: item.start_at != null ? { start: item.start_at, end: item.end_at } : null,
    score: item.score ?? null,
    match_type: item.match_type ?? null,
    knowledge_id: item.knowledge_id || null,
    metadata: item.metadata || {},
  }
}

const toolDef = [
  {
    name: 'search',
    description: `在知识库中精确检索原始文本片段，返回 JSON 格式的匹配结果及来源元数据。
不进行 LLM 总结，只检索原始分块。
适用于精确查找原文、获取引用来源的场景。
参数：
- query: 搜索查询文本
- kb_ids: 知识库 ID 列表，可选，不传则搜索所有知识库`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索查询文本' },
        kb_ids: { type: 'array', items: { type: 'string' }, description: '知识库 ID 列表（可选）' },
      },
      required: ['query'],
    },
  },
  {
    name: 'knowledge_chat',
    description: `基于知识库进行智能问答。会通过知识图谱增强检索（图查询），返回 JSON 格式的自然语言答案及引用来源。
适用于需要综合分析、多步推理或查找关联知识的场景。
注意：会消耗 LLM Token 来生成答案，查询速度比 search 慢。
参数：
- query: 用户问题
- kb_ids: 知识库 ID 列表，可选
- agent_id: Agent ID，可选`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '用户问题' },
        kb_ids: { type: 'array', items: { type: 'string' }, description: '知识库 ID 列表（可选）' },
        agent_id: { type: 'string', description: 'Agent ID（可选）' },
      },
      required: ['query'],
    },
  },
]

// 启动即发送 tools/setup（兼容 opencode 主动注册模式）
sendMsg({ jsonrpc: '2.0', method: 'tools/setup', params: { tools: toolDef } })

rl.on('line', (line) => {
  let req
  try { req = JSON.parse(line) } catch { return }

  // 1. initialize 握手
  if (req.method === 'initialize') {
    sendMsg({
      jsonrpc: '2.0', id: req.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'weknora', version: '1.0.0' },
      },
    })
    return
  }

  // 2. tools/list — 标准工具发现
  if (req.method === 'tools/list') {
    sendMsg({ jsonrpc: '2.0', id: req.id, result: { tools: toolDef } })
    return
  }

  // 3. tools/call — search (知识库精确检索)
  if (req.method === 'tools/call' && req.params?.name === 'search') {
    const { query, kb_ids } = req.params.arguments || {}
    if (!query) {
      sendMsg({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: 'query is required' } })
      return
    }
    ;(async () => {
      try {
        const body = { query }
        if (kb_ids && kb_ids.length > 0) body.knowledge_base_ids = kb_ids
        const res = await fetch(`${WEKNORA_URL}/api/v1/knowledge-search`, {
          method: 'POST',
          headers: { 'X-API-Key': WEKNORA_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(300000),
        })
        if (!res.ok) {
          sendMsg({ jsonrpc: '2.0', id: req.id, error: { code: -32001, message: `WeKnora API error: ${res.status}` } })
          return
        }
        const data = await res.json()
        const items = (data.data || []).slice(0, 5)
        const result = JSON.stringify({
          results: items.map(item => itemToResult(item)),
        }, null, 2)
        sendMsg({
          jsonrpc: '2.0', id: req.id,
          result: { content: [{ type: 'text', text: result || '未检索到相关内容' }] },
        })
      } catch (err) {
        sendMsg({ jsonrpc: '2.0', id: req.id, error: { code: -32002, message: err.message } })
      }
    })()
    return
  }

  // 4. tools/call — knowledge_chat (知识库智能问答，含图查询)
  if (req.method === 'tools/call' && req.params?.name === 'knowledge_chat') {
    const { query, kb_ids, agent_id } = req.params.arguments || {}
    if (!query) {
      sendMsg({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: 'query is required' } })
      return
    }
    ;(async () => {
      try {
        // 1. 创建 session（knowledge-chat 要求 session 预存在）
        const sessionRes = await fetch(`${WEKNORA_URL}/api/v1/sessions`, {
          method: 'POST',
          headers: { 'X-API-Key': WEKNORA_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: `mcp-${Date.now()}`, description: query.slice(0, 100) }),
        })
        if (!sessionRes.ok) {
          sendMsg({ jsonrpc: '2.0', id: req.id, error: { code: -32001, message: `Create session error: ${sessionRes.status}` } })
          return
        }
        const sessionData = await sessionRes.json()
        const sessionId = sessionData.data.id
        if (!sessionId) {
          sendMsg({ jsonrpc: '2.0', id: req.id, error: { code: -32001, message: 'Failed to create session' } })
          return
        }

        const body = { query }
        if (kb_ids && kb_ids.length > 0) body.knowledge_base_ids = kb_ids
        if (agent_id) body.agent_id = agent_id

        const res = await fetch(`${WEKNORA_URL}/api/v1/knowledge-chat/${sessionId}`, {
          method: 'POST',
          headers: { 'X-API-Key': WEKNORA_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!res.ok) {
          sendMsg({ jsonrpc: '2.0', id: req.id, error: { code: -32001, message: `WeKnora API error: ${res.status}` } })
          return
        }

        const refs = []
        let answer = ''
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const result = await Promise.race([
            reader.read().then(({ done, value }) => ({ done, value })),
            new Promise(resolve => setTimeout(() => resolve({ timedOut: true }), 300_000)),
          ])
          if (result.timedOut) break
          if (result.done) break
          buffer += decoder.decode(result.value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''
          for (const line of lines) {
            if (!line.startsWith('data:')) continue
            try {
              const evt = JSON.parse(line.slice(5).trim())
              if (evt.response_type === 'references' && evt.knowledge_references) {
                refs.push(...evt.knowledge_references)
              } else if (evt.response_type === 'answer' && evt.content) {
                answer += evt.content
              }
            } catch {}
          }
        }

        const result = JSON.stringify({
          answer: answer || '',
          references: refs.map(item => itemToResult(item)),
        }, null, 2)

        sendMsg({
          jsonrpc: '2.0', id: req.id,
          result: { content: [{ type: 'text', text: result }] },
        })
      } catch (err) {
        sendMsg({ jsonrpc: '2.0', id: req.id, error: { code: -32002, message: err.message } })
      }
    })()
    return
  }
})
