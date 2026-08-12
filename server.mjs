#!/usr/bin/env node

import {
  createReadStream,
  existsSync,
  statSync,
  unwatchFile,
  watchFile,
} from 'node:fs'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const toolDir = resolve(fileURLToPath(new URL('.', import.meta.url)))
const args = process.argv.slice(2)
const port = readOption('--port', 4319)
const inputFile = readOption('--file')
const repoDir = readOption('--cwd', process.cwd())
const startDev = args.includes('--dev')
const quietMode = args.includes('--quiet') || args.includes('--silent')

const clients = new Map()
const history = []
const maxHistory = 2000
let childProcess
let fileOffset = 0
let fileWatcher
let isShuttingDown = false
const streamStates = new Map()

function readOption(name, fallback) {
  const index = args.indexOf(name)
  return index === -1 ? fallback : args[index + 1]
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  })
  response.end(JSON.stringify(body))
}

function classify(message, requestedLevel) {
  if (requestedLevel) return requestedLevel
  return getLeadingLevel(message) || 'log'
}

function publish(message, metadata = {}) {
  if (!message) return

  const entry = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    time: new Date().toISOString(),
    level: classify(message, metadata.level),
    source: metadata.source || 'dev',
    message,
  }

  history.push(entry)
  if (history.length > maxHistory) history.shift()

  broadcastEvent('message', entry)
  return entry
}

function appendToEntry(entry, message) {
  entry.message += `\n${message}`
  broadcastEvent('update', {
    id: entry.id,
    message: entry.message,
  })
}

function broadcastEvent(eventName, data) {
  for (const [client, state] of clients) {
    if (state.replaying) {
      state.queue.push({ eventName, data })
      continue
    }
    sendSseEvent(client, eventName, data)
  }
}

function sendSseEvent(client, eventName, data) {
  const prefix = eventName === 'message' ? '' : `event: ${eventName}\n`
  client.write(`${prefix}data: ${JSON.stringify(data)}\n\n`)
}

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
}

function getLeadingLevel(line) {
  const match = stripAnsi(line).trim().match(/^(log|warn|error)\b/i)
  return match ? match[1].toLowerCase() : null
}

function getStreamState(source) {
  if (!streamStates.has(source)) {
    streamStates.set(source, {
      buffer: '',
      partialTimer: null,
      seenHeader: false,
      lastEntry: null,
    })
  }
  return streamStates.get(source)
}

function processCompleteLine(line, source, state) {
  if (!line) return
  const level = getLeadingLevel(line)
  if (level) {
    state.seenHeader = true
    state.lastEntry = publish(line, { source, level })
    return
  }
  if (state.seenHeader && state.lastEntry) {
    appendToEntry(state.lastEntry, line)
    return
  }
  state.lastEntry = publish(line, { source, level: 'log' })
}

function schedulePartialFlush(state, source) {
  clearTimeout(state.partialTimer)
  state.partialTimer = setTimeout(() => {
    if (!state.buffer) return
    const line = state.buffer
    state.buffer = ''
    processCompleteLine(line, source, state)
  }, 80)
}

function publishChunk(chunk, source) {
  const state = getStreamState(source)
  state.buffer += chunk.toString().replace(/\r\n/g, '\n')
  const lines = state.buffer.split('\n')
  state.buffer = lines.pop() || ''
  for (const line of lines) processCompleteLine(line, source, state)
  if (state.buffer) schedulePartialFlush(state, source)
}

function flushLogBuffers() {
  for (const [source, state] of streamStates) {
    clearTimeout(state.partialTimer)
    if (state.buffer) {
      processCompleteLine(state.buffer, source, state)
      state.buffer = ''
    }
  }
}

function forwardDevOutput(chunk, output, channel) {
  const text = chunk.toString().replace(/\r\n/g, '\n')
  if (!quietMode) {
    for (const line of text.split('\n')) {
      if (!line) continue
      output.write(`[RN/${channel}] ${line}\n`)
    }
  }
  publishChunk(chunk, `rn-${channel}`)
}

function openInVsCode(filePath, lineNumber) {
  const target = lineNumber ? `${filePath}:${lineNumber}` : filePath
  try {
    const editorProcess = spawn('code', ['--reuse-window', '--goto', target], {
      detached: true,
      stdio: 'ignore',
    })
    editorProcess.once('error', error => {
      publish(`无法通过 code CLI 打开 VS Code: ${error.message}`, {
        source: 'launcher',
        level: 'error',
      })
    })
    editorProcess.unref()
  } catch (error) {
    publish(`无法通过 code CLI 打开 VS Code: ${error.message}`, {
      source: 'launcher',
      level: 'error',
    })
  }
}

function startFileTail(filePath) {
  const absolutePath = resolve(filePath.replace(/^~(?=$|\/)/, homedir()))
  if (!existsSync(absolutePath)) {
    publish(`等待日志文件创建: ${absolutePath}`, { source: 'file', level: 'warn' })
  }

  function readNewContent() {
    if (!existsSync(absolutePath)) return
    const size = statSync(absolutePath).size
    if (size < fileOffset) fileOffset = 0
    if (size === fileOffset) return

    const stream = createReadStream(absolutePath, {
      start: fileOffset,
      end: size - 1,
    })
    let content = ''
    stream.on('data', chunk => {
      content += chunk.toString()
    })
    stream.on('end', () => {
      fileOffset = size
      publishChunk(content, 'file')
    })
  }

  if (existsSync(absolutePath)) fileOffset = statSync(absolutePath).size
  fileWatcher = setInterval(readNewContent, 250)
  publish(`已监听日志文件: ${absolutePath}`, { source: 'file' })
}

function startDevProcess() {
  if (isDevProcessRunning()) return false

  console.log(`[RN Log Viewer] 正在启动 pnpm dev: ${repoDir}`)
  try {
    childProcess = spawn('pnpm', ['dev'], {
      cwd: repoDir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
  } catch (error) {
    console.error(`[RN Log Viewer] 无法启动 pnpm dev: ${error.message}`)
    publish(`无法启动 pnpm dev: ${error.message}`, {
      source: 'launcher',
      level: 'error',
    })
    return false
  }

  publish(`已启动 pnpm dev，工作目录: ${repoDir}`, { source: 'launcher' })
  childProcess.stdout.on('data', chunk => {
    forwardDevOutput(chunk, process.stdout, 'stdout')
  })
  childProcess.stderr.on('data', chunk => {
    forwardDevOutput(chunk, process.stderr, 'stderr')
  })
  childProcess.on('close', code => {
    flushLogBuffers()
    console.log(`[RN Log Viewer] pnpm dev 已退出，退出码: ${code ?? 'unknown'}`)
    publish(`pnpm dev 已退出，退出码: ${code ?? 'unknown'}`, {
      source: 'launcher',
      level: code === 0 ? 'log' : 'error',
    })
  })
  childProcess.on('error', error => {
    console.error(`[RN Log Viewer] 无法启动 pnpm dev: ${error.message}`)
    publish(`无法启动 pnpm dev: ${error.message}`, {
      source: 'launcher',
      level: 'error',
    })
  })
  return true
}

function isDevProcessRunning() {
  return Boolean(
    childProcess &&
      childProcess.exitCode === null &&
      !childProcess.killed
  )
}

function servePage(response) {
  const pagePath = resolve(toolDir, 'index.html')
  const stream = createReadStream(pagePath)
  stream.on('error', error => {
    sendJson(response, 500, { error: error.message })
  })
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  stream.pipe(response)
}

const pagePath = resolve(toolDir, 'index.html')

function startPageHotReload() {
  watchFile(pagePath, { interval: 300 }, (current, previous) => {
    if (current.mtimeMs === previous.mtimeMs) return
    broadcastEvent('reload', { reason: 'index.html changed' })
    console.log('[RN Log Viewer] 检测到前端页面变化，已通知浏览器热更新')
  })
}

const server = createServer((request, response) => {
  const requestUrl = new URL(request.url || '/', `http://${request.headers.host}`)

  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    })
    response.end()
    return
  }

  if (request.method === 'GET' && requestUrl.pathname === '/') {
    servePage(response)
    return
  }

  if (request.method === 'GET' && requestUrl.pathname === '/events') {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    })
    response.write(': connected\n\n')
    const clientState = { replaying: true, queue: [] }
    clients.set(response, clientState)
    const snapshot = history.slice()
    sendSseEvent(response, 'replay-start', { total: snapshot.length })
    for (let index = 0; index < snapshot.length; index += 1) {
      sendSseEvent(response, 'message', snapshot[index])
      sendSseEvent(response, 'replay-progress', {
        current: index + 1,
        total: snapshot.length,
      })
    }
    clientState.replaying = false
    for (const event of clientState.queue) {
      sendSseEvent(response, event.eventName, event.data)
    }
    clientState.queue.length = 0
    sendSseEvent(response, 'replay-end', { total: snapshot.length })
    request.on('close', () => clients.delete(response))
    return
  }

  if (request.method === 'GET' && requestUrl.pathname === '/api/status') {
    sendJson(response, 200, {
      clients: clients.size,
      entries: history.length,
      childPid: childProcess?.pid || null,
      devRunning: isDevProcessRunning(),
      devCwd: repoDir,
      hotReload: true,
      mode: isDevProcessRunning()
        ? 'dev'
        : inputFile
          ? 'file'
          : 'receiver',
    })
    return
  }

  if (request.method === 'GET' && requestUrl.pathname === '/api/open-file') {
    const filePath = requestUrl.searchParams.get('path')
    const lineNumber = requestUrl.searchParams.get('line')
    if (!filePath) {
      sendJson(response, 400, { error: 'path is required' })
      return
    }
    openInVsCode(filePath, lineNumber)
    sendJson(response, 202, { opened: true, path: filePath, line: lineNumber })
    return
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/dev/start') {
    if (isShuttingDown) {
      sendJson(response, 503, { error: 'monitor is shutting down' })
      return
    }
    const started = startDevProcess()
    sendJson(response, started ? 202 : 200, {
      started,
      devRunning: isDevProcessRunning(),
    })
    return
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/dev/stop') {
    if (!isDevProcessRunning()) {
      sendJson(response, 200, { stopped: false, devRunning: false })
      return
    }
    const processToStop = childProcess
    waitForProcessExit(processToStop, 'pnpm dev').then(() => {
      sendJson(response, 200, { stopped: true, devRunning: false })
    })
    return
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/dev/restart') {
    if (isShuttingDown) {
      sendJson(response, 503, { error: 'monitor is shutting down' })
      return
    }
    const processToStop = childProcess
    waitForProcessExit(processToStop, 'pnpm dev').then(() => {
      const started = startDevProcess()
      sendJson(response, started ? 202 : 500, {
        started,
        devRunning: isDevProcessRunning(),
      })
    })
    return
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/log') {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => {
      body += chunk
      if (body.length > 1024 * 1024) request.destroy()
    })
    request.on('end', () => {
      try {
        const payload = JSON.parse(body)
        const message = typeof payload === 'string'
          ? payload
          : payload.message || JSON.stringify(payload.data ?? payload)
        publish(String(message), payload)
      } catch {
        publish(body, { source: 'http' })
      }
      sendJson(response, 202, { accepted: true })
    })
    return
  }

  if (request.method === 'GET' && requestUrl.pathname === '/index.html') {
    servePage(response)
    return
  }

  response.writeHead(404)
  response.end('Not Found')
})

server.listen(port, '127.0.0.1', () => {
  console.log(`[RN Log Viewer] 网页地址: http://127.0.0.1:${port}`)
  console.log(`[RN Log Viewer] 模式: ${startDev ? '代理启动 pnpm dev' : '日志接收'}`)
  if (quietMode) console.log('[RN Log Viewer] RN 终端输出: 已关闭，网页收集保持开启')
  console.log('[RN Log Viewer] 前端页面热更新: 已开启')
  startPageHotReload()
  if (startDev) startDevProcess()
  if (inputFile) startFileTail(inputFile)
})

function waitForProcessExit(processHandle, name) {
  if (!processHandle || processHandle.exitCode !== null) {
    return Promise.resolve()
  }

  return new Promise(resolvePromise => {
    let isResolved = false
    const resolveOnce = () => {
      if (isResolved) return
      isResolved = true
      resolvePromise()
    }

    processHandle.once('close', resolveOnce)
    try {
      process.kill(-processHandle.pid, 'SIGTERM')
    } catch {
      processHandle.kill('SIGTERM')
    }

    setTimeout(() => {
      if (isResolved) return
      console.warn(`[RN Log Viewer] ${name} 未在 5 秒内退出，强制结束`)
      try {
        process.kill(-processHandle.pid, 'SIGKILL')
      } catch {
        processHandle.kill('SIGKILL')
      }
      resolveOnce()
    }, 5000)
  })
}

async function shutdown() {
  if (isShuttingDown) return
  isShuttingDown = true
  console.log('[RN Log Viewer] 收到 Ctrl+C，正在先关闭 RN 进程')
  unwatchFile(pagePath)

  await waitForProcessExit(childProcess, 'pnpm dev')
  flushLogBuffers()
  console.log('[RN Log Viewer] RN 进程已关闭，正在关闭日志监控')
  if (fileWatcher) clearInterval(fileWatcher)
  for (const client of clients.keys()) client.end()
  server.close(() => {
    console.log('[RN Log Viewer] 监控服务已关闭')
    process.exit(0)
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
