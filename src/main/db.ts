import initSqlJs, { type Database } from 'sql.js'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
let db: Database
let dbPath: string

export async function initDatabase() {
  const dir = process.cwd()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  dbPath = join(dir, 'czbot.db')

  const SQL = await initSqlJs()
  const buffer = existsSync(dbPath) ? readFileSync(dbPath) : null
  db = new SQL.Database(buffer)

  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    reasoning TEXT,
    tools TEXT,
    files TEXT,
    agent TEXT,
    step_finish TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  )`)

  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at)`)

  try {
    db.run(`ALTER TABLE messages ADD COLUMN step_finish TEXT`)
  } catch {}

  saveDb()
}

export function getDb(): Database {
  return db
}

export function saveDb() {
  writeFileSync(dbPath, db.export())
}
