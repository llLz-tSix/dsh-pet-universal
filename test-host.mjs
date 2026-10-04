/**
 * Smoke test for the dsh-pet host half.
 *
 * Mounts the plugin against a fake web server and drives the route handler: the
 * status bridge, the state probe, the method guards, and the two real GIFs. The
 * window itself is a separate process and is covered by test-desktop.mjs, so
 * auto-start is switched off here — nothing should pop up over the screen while
 * this runs.
 */
import { statSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply, name } from './index.js'

const HERE = dirname(fileURLToPath(import.meta.url))

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

// ── mount against a fake host, with auto-start off ────────────────────────────
let route
let injected = false
const ctx = {
  inject(services, callback) {
    injected = services.includes('webServer')
    callback({
      webServer: { register(spec) { route = spec; return () => {} } },
      effect(fn) { fn(); return () => {} },
    })
  },
  logger: { info() {}, warn() {} },
}
apply(ctx, { autoStart: false })

check('host half injects the webServer service', injected)
check('registers a prefix route', route?.kind === 'prefix', String(route?.kind))
check('mounts under /api/dsh-pet', route?.path === '/api/dsh-pet', String(route?.path))
check('exports the plugin name', name === 'dsh-pet', String(name))

// ── a tiny request/response harness ───────────────────────────────────────────
// The request is a real EventEmitter so the JSON body reader sees data/end.
const call = async (method, url, body) => {
  const out = { status: undefined, headers: undefined, body: undefined }
  const res = {
    writeHead(status, headers) { out.status = status; out.headers = headers },
    end(body) { out.body = body },
  }
  const req = new EventEmitter()
  req.method = method
  req.url = url
  const pending = route.handler(req, res)
  if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
  req.emit('end')
  await pending
  return out
}

const json = response => {
  try {
    return JSON.parse(String(response.body))
  } catch {
    return undefined
  }
}

// ── status bridge ─────────────────────────────────────────────────────────────
const idle = await call('GET', '/api/dsh-pet/state')
check('state starts with no pet alive',
  idle.status === 200 && json(idle)?.alive === false, `${idle.status} ${idle.body}`)
check('state starts idle', json(idle)?.state === 'idle', String(idle.body))
check('state starts not running', json(idle)?.running === false, String(idle.body))
check('state starts with no waiting mark', json(idle)?.mark === null, String(idle.body))

const busy = await call('POST', '/api/dsh-pet/status', { running: true, pending: null, unread: false })
check('work starting shows the thinking sprite',
  busy.status === 200 && json(busy)?.state === 'thinking', `${busy.status} ${busy.body}`)
check('the running flag is reported back', json(busy)?.running === true, String(busy.body))

const stillBusy = await call('POST', '/api/dsh-pet/status', { running: true, pending: null, unread: false })
check('a repeated busy report keeps thinking', json(stillBusy)?.state === 'thinking', String(stillBusy.body))

// Waiting outranks working: the agent is blocked on the user, and that is the
// one thing the pet must never hide behind a calm animation.
const asking = await call('POST', '/api/dsh-pet/status',
  { running: true, pending: 'approval', unread: false })
check('a permission prompt outranks thinking',
  json(asking)?.state === 'waiting', String(asking.body))
check('the mark says which kind of waiting it is',
  json(asking)?.mark === 'approval', String(asking.body))

const questioned = await call('POST', '/api/dsh-pet/status',
  { running: true, pending: 'question', unread: false })
check('another kind of waiting carries its own mark',
  json(questioned)?.state === 'waiting' && json(questioned)?.mark === 'question',
  String(questioned.body))

const nonsense = await call('POST', '/api/dsh-pet/status',
  { running: true, pending: 'something-else', unread: false })
check('an unknown kind is ignored rather than shown',
  json(nonsense)?.state === 'thinking' && json(nonsense)?.mark === null, String(nonsense.body))

// Finishing, the harness's own way: `completionUnread` is the app saying "done,
// and you have not looked at it", and it clears when the session is opened.
const unread = await call('POST', '/api/dsh-pet/status',
  { running: false, pending: null, unread: true })
check('an unread finished turn shows the tick', json(unread)?.state === 'done', String(unread.body))

const looked = await call('POST', '/api/dsh-pet/status',
  { running: false, pending: null, unread: false })
check('once the user has looked, the tick goes away',
  json(looked)?.state === 'idle', String(looked.body))

// ...and the local latch covers the common case where it never fires: a turn
// that ends while the user is already watching the conversation is not unread.
await call('POST', '/api/dsh-pet/status', { running: true, pending: null, unread: false })
const viaLatch = await call('POST', '/api/dsh-pet/status',
  { running: false, pending: null, unread: false })
check('a turn that simply ended still shows the tick',
  json(viaLatch)?.state === 'done', String(viaLatch.body))

// The whole point of the tick is that it waits. An earlier version returned to
// rest after a fixed few seconds, which hid the only sign that a turn had ended
// — usually while the answer was still being read.
await new Promise(resolve => setTimeout(resolve, 200))
check('the tick waits for the user instead of timing out',
  json(await call('GET', '/api/dsh-pet/state'))?.state === 'done', '')

const junk = await call('POST', '/api/dsh-pet/status', { running: 'yes' })
check('a non-boolean report leaves the tick alone', json(junk)?.state === 'done', String(junk.body))

const ack = await call('POST', '/api/dsh-pet/ack')
check('acknowledging the tick clears it', json(ack)?.cleared === true, String(ack.body))
const afterAck = await call('GET', '/api/dsh-pet/state')
check('the pet is resting after an ack', json(afterAck)?.state === 'idle', String(afterAck.body))

const ackAgain = await call('POST', '/api/dsh-pet/ack')
check('a second ack is a harmless no-op', json(ackAgain)?.cleared === false, String(ackAgain.body))

// ── the pet's click, relayed to the browser half ─────────────────────────────
const noClick = await call('GET', '/api/dsh-pet/events')
check('nothing is pending before the pet is clicked', json(noClick)?.openChat === false, String(noClick.body))

// Clicking the pet opens the chat AND dismisses the tick in one gesture, which
// is what makes the click visibly do something even when the chat it opens is
// the one already on screen — the usual case, since the pet sits next to the
// answer being read.
await call('POST', '/api/dsh-pet/status', { running: true, pending: null, unread: false })
await call('POST', '/api/dsh-pet/status', { running: false, pending: null, unread: false })
const click = await call('POST', '/api/dsh-pet/open-chat')
check('a click on the pet clears the tick too', json(click)?.cleared === true, String(click.body))

const clickEvent = await call('GET', '/api/dsh-pet/events')
check('a click on the pet is delivered', json(clickEvent)?.openChat === true, String(clickEvent.body))

const again = await call('GET', '/api/dsh-pet/events')
check('reading the click clears it, so the chat opens once',
  json(again)?.openChat === false, String(again.body))
check('the pet is resting after the click',
  json(await call('GET', '/api/dsh-pet/state'))?.state === 'idle', '')

// New work overrides the tick, so a finished turn never blocks the next one.
await call('POST', '/api/dsh-pet/status', { running: true, pending: null, unread: false })
await call('POST', '/api/dsh-pet/status', { running: false, pending: null, unread: false })
await call('POST', '/api/dsh-pet/status', { running: true, pending: null, unread: false })
check('new work replaces the tick with thinking',
  json(await call('GET', '/api/dsh-pet/state'))?.state === 'thinking', '')
await call('POST', '/api/dsh-pet/status', { running: false, pending: null, unread: false })
await call('POST', '/api/dsh-pet/ack')

// ── method guards ─────────────────────────────────────────────────────────────
const getStatus = await call('GET', '/api/dsh-pet/status')
check('status only accepts POST', getStatus.status === 405 && getStatus.headers?.allow === 'POST',
  `${getStatus.status} allow=${getStatus.headers?.allow}`)

const postState = await call('POST', '/api/dsh-pet/state')
check('state only accepts GET', postState.status === 405 && postState.headers?.allow === 'GET, HEAD',
  `${postState.status} allow=${postState.headers?.allow}`)

const getShow = await call('GET', '/api/dsh-pet/show')
check('show only accepts POST', getShow.status === 405 && getShow.headers?.allow === 'POST',
  `${getShow.status} allow=${getShow.headers?.allow}`)

const getOpenChat = await call('GET', '/api/dsh-pet/open-chat')
check('open-chat only accepts POST',
  getOpenChat.status === 405 && getOpenChat.headers?.allow === 'POST',
  `${getOpenChat.status} allow=${getOpenChat.headers?.allow}`)

const getAck = await call('GET', '/api/dsh-pet/ack')
check('ack only accepts POST',
  getAck.status === 405 && getAck.headers?.allow === 'POST',
  `${getAck.status} allow=${getAck.headers?.allow}`)

const postEvents = await call('POST', '/api/dsh-pet/events')
check('events only accepts GET',
  postEvents.status === 405 && postEvents.headers?.allow === 'GET, HEAD',
  `${postEvents.status} allow=${postEvents.headers?.allow}`)

const hide = await call('POST', '/api/dsh-pet/hide')
check('hide succeeds and is idempotent', hide.status === 200 && json(hide)?.ok === true,
  `${hide.status} ${hide.body}`)

// ── the four real sprites ─────────────────────────────────────────────────────
for (const file of ['Idle.gif', 'alive.gif', 'thinking.gif', 'done.gif', 'float.gif']) {
  const response = await call('GET', `/api/dsh-pet/assets/${file}`)
  const size = statSync(join(HERE, 'assets', file)).size
  check(`${file}: 200 with an image/gif type`,
    response.status === 200 && response.headers?.['content-type'] === 'image/gif',
    `${response.status} ${response.headers?.['content-type']}`)
  check(`${file}: served whole (${size} bytes)`,
    response.headers?.['content-length'] === String(size) && response.body?.length === size,
    `header=${response.headers?.['content-length']} body=${response.body?.length}`)
  check(`${file}: carries the GIF magic`,
    response.body?.subarray(0, 3).toString('latin1') === 'GIF', String(response.body?.subarray(0, 3)))
}

// ── refusals ──────────────────────────────────────────────────────────────────
const unknown = await call('GET', '/api/dsh-pet/assets/nope.gif')
check('an unlisted name is a 404', unknown.status === 404, String(unknown.status))

const traversal = await call('GET', '/api/dsh-pet/assets/..%2F..%2Fpackage.json')
check('a traversal attempt is refused, not resolved',
  traversal.status === 404
    && !String(traversal.body).includes('"name"')
    && !String(traversal.body).includes('version'),
  `${traversal.status} body=${JSON.stringify(String(traversal.body))}`)

const plain = await call('GET', '/api/dsh-pet/assets/../../../package.json')
check('an unencoded traversal is a 404', plain.status === 404, String(plain.status))

const dir = await call('GET', '/api/dsh-pet/assets/')
check('the bare directory is a 404', dir.status === 404, String(dir.status))

const post = await call('POST', '/api/dsh-pet/assets/Idle.gif')
check('POST is refused with 405', post.status === 405 && post.headers?.allow === 'GET, HEAD',
  `${post.status} allow=${post.headers?.allow}`)

const head = await call('HEAD', '/api/dsh-pet/assets/Idle.gif')
check('HEAD answers 200 with a length and no body',
  head.status === 200 && Number(head.headers?.['content-length']) > 0 && head.body === undefined,
  `${head.status} len=${head.headers?.['content-length']}`)

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
