/**
 * dsh-pet — host half.
 *
 * The pet is a small Electron app that floats on the desktop, over every window.
 * This half starts it, tells it what the agent is doing, serves the sprites, and
 * relays a click on the pet back to the web UI.
 *
 * WHY THE PET IS A SEPARATE PROCESS
 * dsh does not run host plugins inside Electron's main process: the desktop shell
 * starts the whole runtime as a child node process with ELECTRON_RUN_AS_NODE=1,
 * so `require('electron')` here is plain node. And a web page can never paint
 * outside its own window. A pet that lives on the desktop therefore has to be a
 * second Electron app — launched with the Electron binary dsh already ships.
 *
 * TWO DIRECTIONS OF TRAFFIC
 *   browser → pet    POST /status moves this half's state; the child picks it up
 *                    from GET /state on its own poll. A stdin pipe would be
 *                    tidier and simply does not work: Electron's main process
 *                    never emits `data` on one.
 *   pet → browser    POST /open-chat, parked in a flag that the browser half
 *                    collects on GET /events. The pet cannot ask the UI to do
 *                    anything: only a component inside the app window can.
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-pet'

const HERE = dirname(fileURLToPath(import.meta.url))
const ASSET_DIR = join(HERE, 'assets')
const DESKTOP_DIR = join(HERE, 'desktop')
const PREFIX = '/api/dsh-pet'
const MAX_BODY_BYTES = 4096
const KILL_GRACE_MS = 3000

/**
 * The complete allow-list of servable names, mapped to their media type.
 * Serving from a fixed map rather than by joining request input onto the asset
 * directory is what makes path traversal impossible here: a name that is not a
 * key of this map is answered 404 and never reaches the filesystem.
 */
const ASSETS = new Map([
  ['Idle.gif', 'image/gif'],
  ['idle-bubble.gif', 'image/gif'],
  ['alive.gif', 'image/gif'],
  ['thinking.gif', 'image/gif'],
  ['waiting.gif', 'image/gif'],
  ['sleep.gif', 'image/gif'],
  ['held.gif', 'image/gif'],
  ['drop.gif', 'image/gif'],
  ['done.gif', 'image/gif'],
  ['float.gif', 'image/gif'],
  ['mark-approval.png', 'image/png'],
  ['mark-question.png', 'image/png'],
  ['mark-plan.png', 'image/png'],
])

/** The three kinds of "the agent is blocked on you". */
const PENDING_KINDS = ['approval', 'question', 'plan-review']

/** The floating window process, or null while no pet is on screen. */
let pet = null
/** The agent is generating. */
let running = false
/** The agent is blocked waiting for the user, and on what. */
let pending = null
/** The harness's own "finished, not looked at yet" flag. */
let unread = false
/** Our own latch, for the case where `unread` never becomes true. */
let finished = false
/** What the pet shows when the pointer is not on it. */
let state = 'idle'
/** Set by the click of the floating pet, collected by the browser half. */
let openChatRequested = false
/** Base URL of our own routes, handed to the child so it can call back. */
let baseUrl = ''

export function apply(ctx, config) {
  const size = clampSize(config?.size ?? 120)
  const margin = Math.max(0, Number(config?.margin) || 24)
  // `autoStart: false` keeps the pet off the desktop until `/show` is called;
  // the test suite uses it so nothing pops up over whatever is on screen.
  const autoStart = config?.autoStart !== false

  ctx.inject(['webServer'], scoped => {
    scoped.effect(
      () => scoped.webServer.register({ kind: 'prefix', path: PREFIX, handler: serve }),
      'dsh-pet: pet routes',
    )
    // Leaving a stray always-on-top window behind after a reload would be worse
    // than the pet disappearing, so the child dies with the plugin.
    scoped.effect(() => () => stopPet(), 'dsh-pet: floating window')

    const port = scoped.webServer.port
    if (typeof port === 'number' && port > 0) baseUrl = `http://127.0.0.1:${port}${PREFIX}`
    // The pet appears on its own — no dragging it out of the app window.
    if (autoStart) void startPet({ size, margin })
    ctx.logger?.info?.(`dsh-pet: pet started at ${PREFIX}`)
  })
}

// ── the floating window ──────────────────────────────────────────────────────

/**
 * Locate the standalone Electron binary to run the floating window with.
 *
 * Two traps here, both learned the hard way:
 *
 *  - `process.env.DSH_HOME` is NOT set in the plugin process. It is injected
 *    into the shells the agent spawns, not into the runtime, so the obvious
 *    lookup finds nothing. The user's home directory is the dependable fallback:
 *    dsh keeps its own copy of Electron at `<home>/.dsh/electron/`.
 *  - `process.execPath` is the WRONG binary. The runtime does run under Electron
 *    with ELECTRON_RUN_AS_NODE, but it was started by the packaged
 *    `DeepSeek Harness.exe`, and a packaged Electron ignores an app path — it
 *    would relaunch the harness instead of the pet. A candidate is accepted only
 *    when it carries `resources/default_app.asar`, the marker of a plain
 *    Electron runtime.
 *
 * @returns the binary and every path considered, so a failure can say what it tried.
 */
function electronPath() {
  const exe = process.platform === 'win32' ? 'electron.exe' : 'electron'
  const homes = [process.env.DSH_HOME, join(homedir(), '.dsh')]
  const candidates = []
  for (const home of homes) {
    if (typeof home !== 'string' || home === '') continue
    const candidate = join(home, 'electron', exe)
    if (!candidates.includes(candidate)) candidates.push(candidate)
  }
  const found = candidates.find(candidate =>
    existsSync(candidate) && existsSync(join(dirname(candidate), 'resources', 'default_app.asar')))
  return { path: found, candidates }
}

/** Start the desktop pet. Always exactly one: the previous one is gone first. */
async function startPet(options = {}) {
  await stopPet()
  const exe = electronPath().path
  if (exe === undefined) return { ok: false, error: 'electron runtime not found' }
  if (!existsSync(join(DESKTOP_DIR, 'main.js'))) return { ok: false, error: 'desktop app missing' }

  const env = { ...process.env }
  // Without this the child runs as plain node and never creates a window.
  delete env.ELECTRON_RUN_AS_NODE

  const args = [DESKTOP_DIR, `--assets=${ASSET_DIR}`]
  if (baseUrl !== '') args.push(`--api=${baseUrl}`)
  if (typeof options.size === 'number' && Number.isFinite(options.size)) {
    args.push(`--size=${clampSize(options.size)}`)
  }
  if (typeof options.margin === 'number' && Number.isFinite(options.margin)) {
    args.push(`--margin=${Math.max(0, options.margin)}`)
  }
  // No x/y: the child docks itself to the bottom-right of the primary screen.
  if (Number.isFinite(options.x) && Number.isFinite(options.y)) {
    args.push(`--x=${Math.round(options.x)}`, `--y=${Math.round(options.y)}`)
  }

  try {
    const child = spawn(exe, args, {
      env,
      // The child follows our /state route instead of reading a pipe: Electron's
      // main process never emits `data` on a piped stdin, so that channel is a
      // silent dead end.
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: false,
    })
    child.on('error', () => { if (pet === child) pet = null })
    child.on('exit', () => { if (pet === child) pet = null })
    pet = child
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

/**
 * End the desktop pet and resolve once it is really gone.
 *
 * Waiting matters: without it a restart races the old process, and two pets sit
 * on the desktop until one of them dies.
 */
function stopPet() {
  const child = pet
  pet = null
  if (child === null) return Promise.resolve()
  return new Promise(resolve => {
    let settled = false
    const done = () => { if (!settled) { settled = true; resolve() } }
    child.once('exit', done)
    try {
      if (process.platform === 'win32' && child.pid !== undefined) {
        // Electron leaves renderer and GPU children behind; take the tree.
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'],
          { stdio: 'ignore', windowsHide: true }).unref()
      } else {
        child.kill()
      }
    } catch {
      done()
    }
    setTimeout(done, KILL_GRACE_MS).unref()
  })
}

/**
 * Decide what the pet should show.
 *
 * Waiting outranks everything, matching the harness's own sidebar: when the
 * agent is blocked on a permission prompt or a question, that is the one thing
 * the pet must not hide behind a calm animation.
 *
 * Finishing is taken from the harness's `completionUnread` when it fires — that
 * is the app's own "done, not looked at" flag, and it clears exactly when the
 * user opens the session. It does not always fire (a turn that ends while the
 * user is watching the conversation is not unread), so a local latch covers that
 * case and is released by the click on the pet or by `/ack`.
 */
function recompute() {
  if (pending !== null) state = 'waiting'
  else if (running) state = 'thinking'
  else if (unread || finished) state = 'done'
  else state = 'idle'
}

/** Apply a status report from the browser half. */
function report(next) {
  const wasRunning = running
  running = next.running === true

  const kind = next.pending
  pending = typeof kind === 'string' && PENDING_KINDS.includes(kind) ? kind : null

  const nextUnread = next.unread === true
  if (running && !wasRunning) finished = false            // new work wins over anything
  if (wasRunning && !running) finished = true             // a turn just ended
  if (unread && !nextUnread) finished = false             // the harness says: looked at
  unread = nextUnread

  recompute()
}

/**
 * The tick has been seen; go back to resting.
 *
 * Called when the pet itself is clicked (which also opens the chat) and when the
 * browser half reports that the user opened a conversation on their own.
 */
function acknowledge() {
  if (!finished) return false
  finished = false
  recompute()
  return true
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

async function serve(req, res) {
  const method = req.method ?? 'GET'
  let route
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    route = decodeURIComponent(url.pathname).slice(PREFIX.length) || '/'
  } catch {
    route = ''
  }

  if (route === '/status') {
    if (method !== 'POST') return fail(res, 405, 'POST')
    const body = await readJson(req).catch(() => undefined)
    // A request that never parses must not be mistaken for "work finished".
    if (body !== undefined) report(body)
    return json(res, 200, { ok: true, running, state, mark: pending, unread })
  }

  if (route === '/state') {
    if (method !== 'GET' && method !== 'HEAD') return fail(res, 405, 'GET, HEAD')
    // `mark` carries which kind of waiting it is, so the window can pick the
    // right glyph without a second round trip.
    return json(res, 200, { alive: pet !== null, running, state, mark: pending, unread })
  }

  // Polled by the browser half. Reading the flag clears it, so one click opens
  // the chat exactly once even if two polls race.
  if (route === '/events') {
    if (method !== 'GET' && method !== 'HEAD') return fail(res, 405, 'GET, HEAD')
    const openChat = openChatRequested
    openChatRequested = false
    return json(res, 200, { openChat })
  }

  if (route === '/open-chat') {
    if (method !== 'POST') return fail(res, 405, 'POST')
    openChatRequested = true
    // Clicking the pet is also how the tick gets dismissed, so the click has a
    // visible result even when the chat it opens is the one already on screen —
    // which is the usual case, since the pet sits next to the answer you are
    // reading.
    const cleared = acknowledge()
    return json(res, 200, { ok: true, cleared })
  }

  // The user opened a conversation without the pet; the tick has done its job.
  if (route === '/ack') {
    if (method !== 'POST') return fail(res, 405, 'POST')
    return json(res, 200, { ok: true, cleared: acknowledge() })
  }

  if (route === '/show') {
    if (method !== 'POST') return fail(res, 405, 'POST')
    const body = await readJson(req).catch(() => undefined)
    return json(res, 200, await startPet({
      size: clampSize(body?.size),
      margin: Number(body?.margin),
      x: Number(body?.x),
      y: Number(body?.y),
    }))
  }

  if (route === '/hide') {
    if (method !== 'POST') return fail(res, 405, 'POST')
    await stopPet()
    return json(res, 200, { ok: true })
  }

  return serveAsset(req, res, route, method)
}

/** Serve one allow-listed asset; everything else is a 404. */
async function serveAsset(req, res, route, method) {
  if (method !== 'GET' && method !== 'HEAD') return fail(res, 405, 'GET, HEAD')

  const name = route.startsWith('/assets/') ? route.slice('/assets/'.length) : ''
  const type = ASSETS.get(name)
  if (type === undefined) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('dsh-pet: unknown asset\n')
    return
  }

  try {
    const data = await readFile(join(ASSET_DIR, name))
    res.writeHead(200, {
      'content-type': type,
      'content-length': String(data.length),
      // Revalidate rather than cache hard: replacing an artwork file should show
      // up on the next reload, not after a cache expiry.
      'cache-control': 'no-cache',
    })
    res.end(method === 'HEAD' ? undefined : data)
  } catch {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`dsh-pet: cannot read ${name}\n`)
  }
}

function clampSize(value) {
  const size = Number(value)
  if (!Number.isFinite(size)) return 120
  return Math.min(512, Math.max(48, Math.round(size)))
}

function json(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function fail(res, status, allow) {
  res.writeHead(status, { allow, 'content-type': 'text/plain; charset=utf-8' })
  res.end('dsh-pet: method not allowed\n')
}

/** Read a small JSON body, refusing anything oversized. */
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}
