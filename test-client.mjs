/**
 * Smoke test for the dsh-pet browser half.
 *
 * The browser half draws nothing — the pet is the floating desktop window — so
 * what is left to verify is the traffic: each status change forwarded to the
 * host half exactly once, and a click on the pet turned into "open this chat".
 *
 * React is replaced by a small hooks runtime good enough to render one pass and
 * to let effects re-run when their dependencies change. `setInterval` is faked
 * so the click poll can be stepped instead of waited out.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, 'client.js'), 'utf8')

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

/** Let queued promise callbacks run. */
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

// ── a hooks runtime just faithful enough to render one pass ───────────────────
const sameDeps = (a, b) => a.length === b.length && a.every((value, i) => Object.is(value, b[i]))

function makeHooks() {
  const cells = []
  const cleanups = []
  let cursor = 0
  return {
    cells,
    begin() { cursor = 0 },
    /** Unmount: run every effect cleanup so nothing outlives the scenario. */
    teardown() {
      for (const dispose of cleanups.splice(0)) if (typeof dispose === 'function') dispose()
      cells.length = 0
    },
    useRef(initial) {
      const i = cursor++
      if (!(i in cells)) cells[i] = { current: initial }
      return cells[i]
    },
    useEffect(fn, deps) {
      const i = cursor++
      const prev = cells[i]
      if (prev !== undefined && deps !== undefined && sameDeps(prev.deps, deps)) return
      if (prev !== undefined && typeof prev.cleanup === 'function') prev.cleanup()
      const record = { deps: deps ?? [], cleanup: fn() }
      cells[i] = record
      if (typeof record.cleanup === 'function') cleanups.push(record.cleanup)
    },
  }
}

const hooks = makeHooks()
const React = { useRef: hooks.useRef, useEffect: hooks.useEffect }

// ── fake intervals, so the poll can be stepped ────────────────────────────────
const intervals = new Map()
let nextIntervalId = 1
const stepTimers = async () => {
  for (const record of [...intervals.values()]) record.fn()
  await flush()
}

// ── load the bundle through a stub ModuleLoader ───────────────────────────────
const specs = []
const fetchCalls = []
let eventsResponse = { openChat: false }
const fetchStub = (url, init) => {
  fetchCalls.push({ url: String(url), init })
  if (String(url).endsWith('/events')) {
    return Promise.resolve({ json: () => Promise.resolve(eventsResponse) })
  }
  return Promise.resolve({ json: () => Promise.resolve({ ok: true }) })
}

const sandbox = {
  window: { __ModuleLoader__: { load: spec => specs.push(spec) } },
  fetch: fetchStub,
  setInterval: (fn, ms) => { const id = nextIntervalId++; intervals.set(id, { fn, ms }); return id },
  clearInterval: id => intervals.delete(id),
  console,
  Math,
  Number,
  JSON,
  Object,
  Array,
  Map,
  Set,
  Error,
  String,
}
vm.runInNewContext(SRC, sandbox, { filename: 'client.js' })

check('bundle registers exactly one ModuleLoader spec', specs.length === 1, `got ${specs.length}`)
const spec = specs[0]
check('spec id is dsh-pet', spec?.id === 'dsh-pet', String(spec?.id))

const exports = spec.factory(name => {
  if (name === 'react') return React
  throw new Error(`unexpected require(${JSON.stringify(name)})`)
})

check('exports apply/inject/name', typeof exports.apply === 'function'
  && Array.isArray(exports.inject) && exports.name === 'dsh-pet',
  `apply=${typeof exports.apply} inject=${JSON.stringify(exports.inject)} name=${exports.name}`)
check('injects the slots service', exports.inject.includes('slots'))

// ── drive apply() against a recording ctx ────────────────────────────────────
const opened = []
const panels = []
const services = {
  uiWorkspace: { openSession: id => opened.push(id) },
  layout: { selectPanel: name => panels.push(name) },
}

let registered
let injectedKey
const ctx = {
  get: serviceName => services[serviceName],
  slots: {
    inject(key, callback) { injectedKey = key; callback() },
    register(options, component) { registered = { options, component }; return () => {} },
  },
  logger: { info() {}, warn() {} },
}
exports.apply(ctx, {})

check('registers into shell.overlay', injectedKey === 'shell.overlay', String(injectedKey))
check('uses a fresh, non-shipped id', registered?.options?.id === 'dsh-pet', String(registered?.options?.id))
check('register options carry name + order', registered?.options?.name === 'shell.overlay'
  && typeof registered?.options?.order === 'number', JSON.stringify(registered?.options))

// ── rendering ────────────────────────────────────────────────────────────────
const emptySessions = { byId: {} }

/**
 * A session-status snapshot with one session in it.
 *
 * The stub feeds the REAL selectors rather than returning canned values, so the
 * three signals the pet watches — generating, blocked on the user, and finished
 * but unlooked-at — are exercised the way the shell would exercise them.
 */
const makeSnapshot = ({ running, pending, unread }) => new Map([['s1', {
  running,
  pendingInteraction: pending === null ? undefined : { kind: pending },
  completionUnread: unread,
}]])

/**
 * Render one pass. Each scenario starts by tearing the previous tree down, so a
 * leftover poll interval cannot make one click open the chat several times.
 */
const render = ({ running = false, pending = null, unread = false, sessions, fresh = true } = {}) => {
  if (fresh) hooks.teardown()
  hooks.begin()
  const snapshot = makeSnapshot({ running, pending, unread })
  return registered.component({
    useSessionStatus: selector => selector(snapshot),
    useSessions: selector => selector(sessions === undefined ? emptySessions : sessions),
  })
}

check('the browser half draws no sprite of its own', render() === null)

const statusCalls = () => fetchCalls.filter(call => call.url.endsWith('/status'))
const reports = () => statusCalls().map(call => JSON.parse(call.init.body))
const bodies = () => reports().map(report => report.running)

fetchCalls.length = 0
render({ running: false })
check('the idle status is reported on mount', statusCalls().length === 1, JSON.stringify(bodies()))
check('the report says the agent is idle', bodies()[0] === false, JSON.stringify(bodies()))
check('the report is a POST to the status route',
  statusCalls()[0]?.init?.method === 'POST', String(statusCalls()[0]?.init?.method))
check('the report carries all three signals',
  reports()[0].pending === null && reports()[0].unread === false,
  JSON.stringify(reports()[0]))

fetchCalls.length = 0
render({ running: true, fresh: false })
check('a change to busy is reported', bodies().includes(true), JSON.stringify(bodies()))

fetchCalls.length = 0
render({ running: true, fresh: false })
check('an unchanged status is not reported again', statusCalls().length === 0, JSON.stringify(bodies()))

// Waiting is its own signal even while the agent is still generating: it is
// blocked, and the pet has to say so.
fetchCalls.length = 0
render({ running: true, pending: 'approval', fresh: false })
check('being blocked on the user is reported', reports().at(-1)?.pending === 'approval',
  JSON.stringify(reports()))

fetchCalls.length = 0
render({ running: true, pending: null, fresh: false })
check('the agent carrying on is reported', reports().at(-1)?.pending === null,
  JSON.stringify(reports()))

fetchCalls.length = 0
render({ running: false, unread: true, fresh: false })
check('a finished, unlooked-at turn is reported', reports().at(-1)?.unread === true,
  JSON.stringify(reports()))

fetchCalls.length = 0
render({ running: false, unread: false, fresh: false })
check('looking at it is reported too', reports().at(-1)?.unread === false,
  JSON.stringify(reports()))

fetchCalls.length = 0
render({ running: true, fresh: false })
fetchCalls.length = 0
render({ running: false, fresh: false })
check('returning to idle is reported', bodies().includes(false), JSON.stringify(bodies()))

// ── the click poll ───────────────────────────────────────────────────────────
check('exactly one poll is scheduled', intervals.size === 1, `${intervals.size} interval(s)`)
check('the poll runs about twice a second', [...intervals.values()][0]?.ms <= 2000,
  `${[...intervals.values()][0]?.ms} ms`)

// ── opening the last working chat ────────────────────────────────────────────
const session = (id, extra) => [id, { id, updatedAt: 100, retainedBy: { mainView: 0 }, ...extra }]

opened.length = 0
eventsResponse = { openChat: false }
render({ sessions: { byId: Object.fromEntries([session('s1')]) } })
await stepTimers()
check('no click means no chat is opened', opened.length === 0, JSON.stringify(opened))

eventsResponse = { openChat: true }
await stepTimers()
check('a click opens the most recent session',
  opened.length === 1 && opened[0] === 's1', JSON.stringify(opened))

opened.length = 0
eventsResponse = { openChat: false }
render({ sessions: { byId: Object.fromEntries([
  session('old', { updatedAt: 10 }),
  session('recent', { updatedAt: 900 }),
  session('middle', { updatedAt: 500 }),
]) } })
eventsResponse = { openChat: true }
await stepTimers()
check('with nothing on screen the newest session wins',
  opened.length === 1 && opened[0] === 'recent', JSON.stringify(opened))

opened.length = 0
render({ sessions: { byId: Object.fromEntries([
  session('newest', { updatedAt: 9000 }),
  session('onscreen', { updatedAt: 10, retainedBy: { mainView: 1 } }),
]) } })
eventsResponse = { openChat: true }
await stepTimers()
check('a session already on screen wins over a newer one',
  opened.length === 1 && opened[0] === 'onscreen', JSON.stringify(opened))

// With no workspace service the click should still surface the conversation panel.
opened.length = 0
panels.length = 0
delete services.uiWorkspace
render({ sessions: undefined })
eventsResponse = { openChat: true }
await stepTimers()
check('without a workspace service the panel is brought forward instead',
  opened.length === 0 && panels.length === 1 && panels[0] === null, JSON.stringify(panels))
services.uiWorkspace = { openSession: id => opened.push(id) }

// The slot's `useSessions` prop is the documented route, but a click must not
// hinge on it: the sessions service exposes the very same rows, and that is
// where the UI reads them from too.
opened.length = 0
services.sessions = {
  list: {
    getSnapshot: () => ({
      byId: {
        older: { id: 'older', updatedAt: 10, retainedBy: { mainView: 0 } },
        fromService: { id: 'fromService', updatedAt: 42, retainedBy: { mainView: 0 } },
      },
    }),
  },
}
hooks.teardown()
hooks.begin()
registered.component({ useSessionStatus: () => false })
eventsResponse = { openChat: true }
await stepTimers()
check('a click still finds a session when the slot hands over no list',
  opened.length === 1 && opened[0] === 'fromService', JSON.stringify(opened))
delete services.sessions

// And when there is no list anywhere, the panel still comes forward.
opened.length = 0
panels.length = 0
hooks.teardown()
hooks.begin()
registered.component({ useSessionStatus: () => false })
eventsResponse = { openChat: true }
await stepTimers()
check('a click with no session list anywhere still reveals the conversation',
  opened.length === 0 && panels.length === 1, JSON.stringify(panels))

// ── the selectors, through the component ─────────────────────────────────────
// The component subscribes three times over the same snapshot — generating,
// blocked, unlooked-at — so all three selectors are captured, in order.
const capturedSelectors = []
let capturedSessions
render()
registered.component({
  useSessionStatus: selector => { capturedSelectors.push(selector); return undefined },
  useSessions: selector => { capturedSessions = selector; return undefined },
})
const [busySelector, pendingSelector, unreadSelector] = capturedSelectors
check('the component watches exactly three signals', capturedSelectors.length === 3,
  String(capturedSelectors.length))

check('busy selector: empty map is idle', busySelector(new Map()) === false)
check('busy selector: a running session is busy', busySelector(new Map([['s1', { running: true }]])) === true)
check('busy selector: an idle session is not busy', busySelector(new Map([['s1', { running: false }]])) === false)
check('busy selector: a bare undefined snapshot is not busy', busySelector(undefined) === false)
check('busy selector: a null snapshot does not throw', busySelector(null) === false)

// The interaction arrives either as a bare kind string or as an object with
// `kind`, depending on which UI published it, so both shapes must work.
check('pending selector: nothing pending is null', pendingSelector(new Map()) === null)
check('pending selector: an object form is unwrapped',
  pendingSelector(new Map([['s1', { pendingInteraction: { kind: 'approval' } }]])) === 'approval')
check('pending selector: a bare string form is accepted',
  pendingSelector(new Map([['s1', { pendingInteraction: 'question' }]])) === 'question')
check('pending selector: an interaction without a kind is ignored',
  pendingSelector(new Map([['s1', { pendingInteraction: {} }]])) === null)
check('pending selector: a null snapshot does not throw', pendingSelector(null) === null)

check('unread selector: nothing unread is false', unreadSelector(new Map()) === false)
check('unread selector: an unlooked-at turn is true',
  unreadSelector(new Map([['s1', { completionUnread: true }]])) === true)
check('unread selector: a looked-at turn is false',
  unreadSelector(new Map([['s1', { completionUnread: false }]])) === false)
check('unread selector: a null snapshot does not throw', unreadSelector(null) === false)

check('session selector: an empty list has no target', capturedSessions({ byId: {} }) === undefined)
check('session selector: a missing map does not throw', capturedSessions(undefined) === undefined)
check('session selector: skips empty rows', capturedSessions({ byId: { a: undefined } }) === undefined)
check('session selector: picks the only session',
  capturedSessions({ byId: { a: { id: 'a', updatedAt: 5 } } }) === 'a')

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
