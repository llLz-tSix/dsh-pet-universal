/**
 * End-to-end test for the floating desktop window.
 *
 * Proves the whole chain the plugin uses at runtime, without DSH in the loop:
 * locate the standalone Electron binary, spawn the desktop app without
 * ELECTRON_RUN_AS_NODE, and let its --selftest mode confirm a real window was
 * created. The test spawns one window for about a second, then exits.
 *
 * The lookup below mirrors `electronPath()` in index.js on purpose — keeping one
 * source of truth would mean exporting plugin internals, and Cordis treats every
 * export as plugin surface.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, 'desktop')
const ASSET_DIR = join(HERE, 'assets')
const RESULT = join(DESKTOP_DIR, 'selftest.json')
const CAPTURE = join(DESKTOP_DIR, 'selftest.png')

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

// ── the same candidate chain the plugin uses ──────────────────────────────────
const exe = process.platform === 'win32' ? 'electron.exe' : 'electron'
const homes = [process.env.DSH_HOME, join(homedir(), '.dsh')]
const candidates = []
for (const home of homes) {
  if (typeof home !== 'string' || home === '') continue
  const candidate = join(home, 'electron', exe)
  if (!candidates.includes(candidate)) candidates.push(candidate)
}
const electron = candidates.find(candidate =>
  existsSync(candidate) && existsSync(join(dirname(candidate), 'resources', 'default_app.asar')))

check('a plain Electron runtime is found', electron !== undefined,
  electron ?? `tried ${candidates.join(' | ')}`)
check('the desktop app is present', existsSync(join(DESKTOP_DIR, 'main.js')), DESKTOP_DIR)
check('both sprites are present',
  existsSync(join(ASSET_DIR, 'Idle.gif')) && existsSync(join(ASSET_DIR, 'alive.gif')), ASSET_DIR)

if (electron === undefined) {
  console.log('\ncannot continue without an Electron runtime')
  process.exit(1)
}

// ── launch it exactly the way the plugin does ─────────────────────────────────
const env = { ...process.env }
// Without this the child runs as plain node and never creates a window.
delete env.ELECTRON_RUN_AS_NODE

/** Run --selftest once and return its report. */
const launch = async extraArgs => {
  rmSync(RESULT, { force: true })
  const exit = await new Promise(resolve => {
    const child = spawn(electron, [
      DESKTOP_DIR,
      '--selftest',
      '--size=96',
      `--assets=${ASSET_DIR}`,
      // Long enough that the one-shot transformation cannot fire in the middle
      // of the per-state sweep; the hand-over is checked separately below.
      '--morphMs=1200',
      ...extraArgs,
    ], { env, stdio: 'ignore', windowsHide: false })
    child.on('error', error => resolve({ error }))
    child.on('exit', code => resolve({ code }))
    setTimeout(() => { try { child.kill() } catch { /* already gone */ } resolve({ code: 'timeout' }) }, 30000).unref()
  })
  const report = existsSync(RESULT) ? JSON.parse(readFileSync(RESULT, 'utf8')) : undefined
  return { exit, report }
}

// Dropped at a point the way the browser does it...
const dropped = await launch(['--x=400', '--y=250'])
const exit = dropped.exit
const report = dropped.report

check('the desktop app exits cleanly', exit.code === 0, JSON.stringify(exit))
check('the window was really created', report?.ok === true, JSON.stringify(report))
check('it runs on the bundled Electron', report?.electron === '43.3.0', String(report?.electron))
check('the window is the requested size',
  report?.bounds?.width === 96 && report?.bounds?.height === 96, JSON.stringify(report?.bounds))
check('it is centred on the drop point',
  report?.bounds?.x === 400 - 48 && report?.bounds?.y === 250 - 48, JSON.stringify(report?.bounds))
check('the sprite URL is a properly encoded file URL',
  typeof report?.idleUrl === 'string' && report.idleUrl.startsWith('file:///')
    && !report.idleUrl.includes(' '), String(report?.idleUrl))
check('the sprite file behind that URL exists',
  existsSync(decodeURIComponent(String(report?.idleUrl).replace('file:///', ''))) === true)

// The whole point of the window: something has to be visible in it. A window
// that opens with a blocked script and no sprites looks exactly like a window
// that never opened, so these are the checks that actually matter.
const images = report?.images
const STATES = ['idle', 'joy', 'thinking', 'done', 'float']
const HOST_STATES = ['idle', 'joy', 'thinking', 'done']
check('the page script ran (a too-strict CSP kills it silently)',
  images?.body === '96x96', String(images?.body))

for (const state of STATES) {
  check(`the ${state} sprite decoded`,
    images?.[state]?.complete === true && images[state].naturalWidth > 0,
    JSON.stringify(images?.[state]))
}

/**
 * Opacity is sampled mid-crossfade often enough that exact string comparison is
 * a coin flip; a layer counts as shown when it is essentially opaque.
 */
const shown = value => Number(value) > 0.95
const hidden = value => Number(value) < 0.05

check('the resting state is the one shown at rest',
  shown(images?.idle?.opacity)
    && STATES.filter(s => s !== 'idle').every(s => hidden(images?.[s]?.opacity)),
  STATES.map(s => `${s}=${images?.[s]?.opacity}`).join(' '))

// Every state must switch to its own layer. A specificity mistake here leaves
// layers stacked or blank while the DOM still looks perfectly correct.
for (const state of HOST_STATES) {
  const shot = report?.states?.[state]
  const others = STATES.filter(s => s !== state)
  check(`switching to ${state} shows only that layer`,
    shot?.dataset === state
      && shown(shot?.opacity?.[state])
      && others.every(s => hidden(shot?.opacity?.[s])),
    `${shot?.dataset} ${JSON.stringify(shot?.opacity)}`)
}

// The tick waits for the user, so the transformation must play once and hand
// over to the levitation loop. A looping `done.gif` would burst the whale into
// sparks every four seconds for as long as the tick is up.
const morph = report?.morph
check('the transformation is showing while it plays',
  morph?.during?.layer === 'done', JSON.stringify(morph?.during))
check('the tick hands over to the levitation loop',
  morph?.after?.layer === 'float'
    && shown(morph?.after?.opacity?.float)
    && hidden(morph?.after?.opacity?.done),
  JSON.stringify(morph?.after))

check('the window really painted pixels',
  (report?.capturedBytes ?? 0) > 800, `${report?.capturedBytes} bytes of PNG`)

// On-screen presence is a separate question from page rendering: a transparent
// window can be "created, visible and correctly painted" and still composite to
// nothing. Hardware acceleration is off for exactly that reason.
check('the window reports itself visible',
  report?.visible === true && report?.opacity === 1, `visible=${report?.visible} opacity=${report?.opacity}`)
check('the window is always on top', report?.alwaysOnTop === true, String(report?.alwaysOnTop))

// Dragging is driven from the main process by sampling the cursor, so it can be
// exercised without a physical mouse. It must follow the pointer exactly: the
// page only reports press and release.
check('the drag registers a grab', report?.drag?.grabbed === true, JSON.stringify(report?.drag))
check('the window follows the cursor precisely',
  report?.drag?.dx === 70 && report?.drag?.dy === 55, JSON.stringify(report?.drag))
check('the preload bridge exposes every verb',
  report?.images?.bridge?.dragStart === 'function'
    && report?.images?.bridge?.dragEnd === 'function'
    && report?.images?.bridge?.close === 'function'
    && report?.images?.bridge?.onState === 'function'
    && report?.images?.bridge?.onFlash === 'function',
  JSON.stringify(report?.images?.bridge))
check('the pet docks to the corner when given no drop point',
  report?.bounds?.x > 0 && report?.bounds?.y > 0, JSON.stringify(report?.bounds))

// Docking only helps if the pet actually lands on the screen. `workArea` reports
// physical pixels while window coordinates are DIP, and mixing the two parked
// the window a full screen past the edge — invisible, unreachable, and looking
// exactly like a pet that ignores the mouse. So run the auto-start case too.
const docked = await launch([])
const dockReport = docked.report
const display = dockReport?.display
const scale = display?.scaleFactor > 0 ? display.scaleFactor : 1
const screenWidth = (display?.workArea?.width ?? 0) / scale
const screenHeight = (display?.workArea?.height ?? 0) / scale

check('docking exits cleanly', docked.exit.code === 0, JSON.stringify(docked.exit))
check('a docked pet is created', dockReport?.ok === true, String(dockReport?.ok))
check('a docked pet lands inside the visible screen',
  screenWidth > 0 && screenHeight > 0
    && dockReport.bounds.x >= 0 && dockReport.bounds.y >= 0
    && dockReport.bounds.x + dockReport.bounds.width <= screenWidth
    && dockReport.bounds.y + dockReport.bounds.height <= screenHeight,
  `bounds ${JSON.stringify(dockReport?.bounds)} vs screen ${screenWidth}x${screenHeight} DIP`)

// A drop point near the edge must not push the pet half off the screen either.
const edge = await launch(['--x=760', '--y=450'])
const edgeReport = edge.report
check('a drop near the edge is pulled back on screen',
  edgeReport?.ok === true && screenWidth > 0
    && edgeReport.bounds.x >= 0 && edgeReport.bounds.y >= 0
    && edgeReport.bounds.x + edgeReport.bounds.width <= screenWidth
    && edgeReport.bounds.y + edgeReport.bounds.height <= screenHeight,
  `bounds ${JSON.stringify(edgeReport?.bounds)} vs screen ${screenWidth}x${screenHeight} DIP`)

check('a docked pet sits in the bottom-right corner',
  Math.abs((dockReport?.bounds?.x ?? 0) + (dockReport?.bounds?.width ?? 0) - screenWidth) <= 64
    && Math.abs((dockReport?.bounds?.y ?? 0) + (dockReport?.bounds?.height ?? 0) - screenHeight) <= 64,
  `right gap ${Math.round(screenWidth - ((dockReport?.bounds?.x ?? 0) + (dockReport?.bounds?.width ?? 0)))},`
  + ` bottom gap ${Math.round(screenHeight - ((dockReport?.bounds?.y ?? 0) + (dockReport?.bounds?.height ?? 0)))}`)

for (const file of ['Idle.gif', 'alive.gif', 'thinking.gif', 'done.gif', 'float.gif']) {
  const path = join(ASSET_DIR, file)
  check(`${file} is present and substantial`, statSync(path).size > 1000,
    `${statSync(path).size} bytes`)
}

rmSync(RESULT, { force: true })
rmSync(CAPTURE, { force: true })
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
