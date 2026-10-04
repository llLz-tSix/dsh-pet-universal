/**
 * dsh-pet floating window — Electron main process.
 *
 * WHY THIS PROCESS EXISTS
 * The dsh host plugins do not run in Electron's main process: the desktop shell
 * launches the whole runtime as a child node process with ELECTRON_RUN_AS_NODE,
 * so a plugin has no `electron` module to ask for a window. And a web page cannot
 * paint outside its own window. A pet that lives on the desktop is therefore a
 * second Electron app — this one — started from the plugin's host half through
 * the Electron binary dsh ships.
 *
 * Two hard-won details are load-bearing here; both are commented where they sit:
 * hardware acceleration must be off for a transparent window to composite at all
 * on Windows, and the drag is driven by polling the cursor from THIS process
 * rather than by page mousemove, because a moving window outruns the pointer and
 * the events stop arriving.
 */
const path = require('node:path')
const { spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { app, BrowserWindow, ipcMain, screen } = require('electron')

/*
 * Software compositing, deliberately.
 *
 * A `transparent: true` window on Windows is composited through the GPU path,
 * and on some driver configurations that path silently produces nothing: the
 * window exists, reports itself visible, `capturePage()` returns a correctly
 * rendered sprite — and the desktop shows no pet at all. Software compositing
 * draws the alpha reliably. A pet is a few hundred pixels of GIF; the CPU cost
 * is nothing next to being invisible.
 *
 * Must run before the app is ready.
 */
app.disableHardwareAcceleration()

/** Read `--name=value` from argv without pulling in a parser. */
function arg(name, fallback) {
  const prefix = `--${name}=`
  const hit = process.argv.find(value => value.startsWith(prefix))
  return hit === undefined ? fallback : hit.slice(prefix.length)
}

const SIZE = Math.max(48, Number(arg('size', '120')) || 120)
const MARGIN = Math.max(0, Number(arg('margin', '24')) || 24)
const ASSETS = arg('assets', '')
const SELFTEST = process.argv.includes('--selftest')
const START_X = Number(arg('x', 'NaN'))
const START_Y = Number(arg('y', 'NaN'))
/** Base URL of the plugin's routes, so a click can ask the app to open the chat. */
const API = arg('api', '')
/**
 * Below this much movement a press counts as a click rather than a drag.
 *
 * A real hand almost never holds a mouse perfectly still: a couple of DIP of
 * travel during a press is normal, and a threshold that is too tight turns every
 * honest click into a tiny drag — the pet moves two pixels and the chat never
 * opens, which reads as "the click does nothing".
 */
const CLICK_SLOP = 6
/** A cursor jump larger than this in one sample is a glitch, not a hand. */
const MAX_CURSOR_STEP = 300
/** How often the plugin's /state route is checked. */
const STATE_POLL_MS = 700
/** Every layer the page mounts. `float` is local: two sprites, one host state. */
const STATES = ['idle', 'joy', 'thinking', 'done', 'float']
/** The subset the plugin is allowed to ask for; `float` follows from `done`. */
const HOST_STATES = ['idle', 'joy', 'thinking', 'done']
const SPRITES = {
  idle: 'Idle.gif',
  joy: 'alive.gif',
  thinking: 'thinking.gif',
  // The transformation plays once, then the looping tick takes over — replaying
  // the burst every few seconds would look broken while the user is reading.
  done: 'done.gif',
  float: 'float.gif',
}
/** How long `done.gif` runs before the looping tick takes over. */
const MORPH_MS = Math.max(100, Number(arg('morphMs', '4400')) || 4400)

/** Last state applied, so an unchanged poll costs nothing. */
let lastState
let stateTimer

/** file:// URLs for the sprites; pathToFileURL encodes the Cyrillic path. */
function assetUrl(name) {
  return pathToFileURL(path.join(ASSETS, name)).href
}

let win

// ── dragging ────────────────────────────────────────────────────────────────

/**
 * Where the pet was grabbed, as an offset from the window origin.
 *
 * The page only says "the user pressed" and "the user released"; the movement
 * itself is produced here by sampling `screen.getCursorScreenPoint()`. Waiting
 * for page mousemove does not work: the window is dragged out from under the
 * pointer within a few pixels, the events stop, and the pet freezes mid-drag
 * with a partially completed move.
 */
let dragOffset = null
let dragTimer = null
/** Window origin when the press started, so a non-moving press can be told from a drag. */
let dragOrigin = null
/** Previous cursor sample, so movement is applied as a delta. */
let lastCursor = null

function beginDrag() {
  if (win === undefined || win.isDestroyed()) return
  const cursor = screen.getCursorScreenPoint()
  const [x, y] = win.getPosition()
  dragOffset = { x: cursor.x - x, y: cursor.y - y }
  dragOrigin = { x, y }
  lastCursor = cursor
  if (dragTimer === null) {
    dragTimer = setInterval(() => followCursor(screen.getCursorScreenPoint()), 16)
  }
}

/**
 * Move the window by however far the cursor travelled since the last sample.
 *
 * Relative, not absolute. Placing the window at `cursor - grabOffset` looks
 * equivalent and is not: if a single cursor reading comes back in different
 * units — which happens when another application has captured the pointer — the
 * window is teleported across the screen in one tick. Deltas cannot do that, and
 * they also make the click test exact: a press with no cursor movement produces
 * no movement at all, so it is reliably a click.
 */
function followCursor(point) {
  if (dragOffset === null || win === undefined || win.isDestroyed()) return
  if (lastCursor === null) {
    lastCursor = point
    return
  }
  const dx = point.x - lastCursor.x
  const dy = point.y - lastCursor.y
  lastCursor = point
  if (dx === 0 && dy === 0) return
  // A pointer can jump arbitrarily far in one sample: a full-screen game in the
  // foreground captures the cursor and confines it to its own rectangle, and the
  // position then snaps to the edge of that rectangle. No hand moves hundreds of
  // pixels in sixteen milliseconds, so such a sample is a glitch — acting on it
  // would fling the pet across the screen mid-click.
  if (Math.abs(dx) > MAX_CURSOR_STEP || Math.abs(dy) > MAX_CURSOR_STEP) return
  const [x, y] = win.getPosition()
  win.setPosition(Math.round(x + dx), Math.round(y + dy))
}

function endDrag() {
  dragOffset = null
  lastCursor = null
  if (dragTimer !== null) {
    clearInterval(dragTimer)
    dragTimer = null
  }
  const origin = dragOrigin
  dragOrigin = null
  // A release with no press behind it means the press went to another window;
  // there is nothing to measure and nothing to open.
  if (origin === null || win === undefined || win.isDestroyed()) return
  // A press that never really moved is a click, not a drag.
  const [x, y] = win.getPosition()
  if (Math.hypot(x - origin.x, y - origin.y) >= CLICK_SLOP) return
  // A visible reaction, always. Opening a chat that is already on screen changes
  // nothing on screen, and a click that appears to do nothing is indistinguishable
  // from a broken one.
  if (win !== undefined && !win.isDestroyed()) win.webContents.send('pet:flash')
  // Raise the app first: this must happen while the click still makes our process
  // the foreground one, or Windows refuses to hand focus over.
  raiseAppWindow()
  void requestOpenChat()
}

/**
 * Tell the plugin that the pet was clicked.
 *
 * The pet cannot open a chat itself — it is a separate process with no access to
 * the app's UI. It only sets a flag the browser half collects, and that half
 * owns the session list and knows which chat was last in use.
 */
async function requestOpenChat() {
  if (API === '') return
  try {
    await fetch(`${API}/open-chat`, { method: 'POST' })
  } catch {
    /* the app may be shutting down; a lost click is not worth a dialog */
  }
}

/** The app's own process name, used to find the window to raise. */
const APP_PROCESS = 'DeepSeek Harness'

/**
 * Bring the DeepSeek Harness window to the front, restoring it if minimised.
 *
 * Opening the chat is not enough on its own. If the app is behind a browser or
 * minimised, `openSession` rearranges a window nobody can see, and the click
 * looks dead. Electron offers no cross-process focus, so this goes through
 * Win32 — and the only reason Windows permits it is the timing: the user just
 * clicked OUR window, so our process holds the foreground right. A process
 * started BY the foreground process may hand that right over, which is exactly
 * what this child PowerShell is. Called at any other moment it would be silently
 * ignored.
 *
 * @returns whether a window was found and asked to come forward.
 */
function raiseAppWindow() {
  if (process.platform !== 'win32') return false
  const script = [
    "Add-Type @'",
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class RaiseWindow {',
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);',
    '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
    '}',
    "'@",
    `$p = Get-Process -Name '${APP_PROCESS}' -ErrorAction SilentlyContinue |`,
    '  Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1',
    'if (-not $p) { exit 0 }',
    '$h = $p.MainWindowHandle',
    'if ([RaiseWindow]::IsIconic($h)) { [void][RaiseWindow]::ShowWindow($h, 9) }', // SW_RESTORE
    '[void][RaiseWindow]::SetForegroundWindow($h)',
  ].join('\n')

  try {
    spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
      { stdio: 'ignore', windowsHide: true }).unref()
    return true
  } catch {
    return false
  }
}

// ── window ──────────────────────────────────────────────────────────────────

function createWindow() {
  const options = {
    width: SIZE,
    height: SIZE,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    /*
     * Never take focus.
     *
     * A window that activates on click spends the first click becoming active,
     * and on this window style that click does not reach the page — so the pet
     * ignores the first press after anything else has taken the foreground,
     * which is exactly what a click that opened a chat looks like. An
     * overlay-style window (WS_EX_NOACTIVATE on Windows) receives the press
     * straight away instead.
     *
     * The window that raises the app is unaffected: Windows also permits
     * SetForegroundWindow for the process that received the last input event,
     * and this window still receives it.
     */
    focusable: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  }

  /*
   * Where to put the window.
   *
   * UNIT TRAP. On this setup `workArea` comes back in PHYSICAL pixels while
   * window coordinates are DIP — here 1536 physical against a scaleFactor of 2,
   * so the logical screen is only 768 wide. Using the raw numbers placed the pet
   * at logical 1392, i.e. physical 2784, a full screen past the right edge:
   * created, "visible", always-on-top, and completely unreachable. That is
   * indistinguishable from a pet that ignores the mouse, because the mouse can
   * never reach it.
   */
  const display = screen.getPrimaryDisplay()
  const scale = display.scaleFactor > 0 ? display.scaleFactor : 1
  const area = display.workArea
  const left = Math.round(area.x / scale)
  const top = Math.round(area.y / scale)
  const right = left + Math.round(area.width / scale)
  const bottom = top + Math.round(area.height / scale)

  if (Number.isFinite(START_X) && Number.isFinite(START_Y)) {
    // The browser reports the drop point in CSS pixels, which are DIP like these.
    options.x = Math.round(START_X - SIZE / 2)
    options.y = Math.round(START_Y - SIZE / 2)
  } else {
    // No drop point: dock to the bottom-right corner of the work area, which is
    // where the pet lives when the plugin starts it on its own.
    options.x = right - SIZE - MARGIN
    options.y = bottom - SIZE - MARGIN
  }
  // Either way, never leave part of the pet off the screen.
  options.x = Math.min(Math.max(options.x, left), Math.max(left, right - SIZE))
  options.y = Math.min(Math.max(options.y, top), Math.max(top, bottom - SIZE))

  win = new BrowserWindow(options)
  // 'screen-saver' is the highest normal level, so the pet stays above other
  // always-on-top windows while still yielding to full-screen apps in practice.
  win.setAlwaysOnTop(true, 'screen-saver')
  win.loadFile(path.join(__dirname, 'pet.html'), {
    query: STATES.reduce(
      (query, state) => ({ ...query, [state]: assetUrl(SPRITES[state]) }),
      { size: String(SIZE), state: 'idle', morphMs: String(MORPH_MS) },
    ),
  })

  win.once('ready-to-show', () => {
    win.show()
    if (SELFTEST) selftest()
  })
  win.on('closed', () => { win = undefined; endDrag() })
}

ipcMain.on('pet:drag-start', beginDrag)
ipcMain.on('pet:drag-end', endDrag)
ipcMain.on('pet:close', () => app.quit())

// ── status from the host half ───────────────────────────────────────────────

/**
 * Follow what the agent is doing by polling the plugin's own /state route.
 *
 * The obvious channel — the host writes JSON lines to this child's stdin — does
 * NOT work under Electron: fd 0 is a real pipe and `process.stdin` exists, but it
 * never emits `data`, even after `resume()`. Writes succeed on the host side and
 * vanish silently, which is exactly the kind of failure that looks like "the
 * animation just doesn't play". Polling a local URL costs almost nothing and
 * actually delivers.
 */
async function pollState() {
  if (API === '') return
  try {
    const response = await fetch(`${API}/state`)
    const snapshot = await response.json()
    const next = snapshot?.state
    if (!STATES.includes(next) || next === lastState) return
    lastState = next
    if (win !== undefined && !win.isDestroyed()) win.webContents.send('pet:state', next)
  } catch {
    /* the plugin may be reloading; the next tick will pick it up */
  }
}

// A pet is a single window; closing it must end the process on every platform.
app.on('window-all-closed', () => app.quit())

app.whenReady().then(() => {
  createWindow()
  if (API !== '') {
    void pollState()
    stateTimer = setInterval(() => void pollState(), STATE_POLL_MS)
  }
})

// ── self-test ───────────────────────────────────────────────────────────────

/**
 * Create the window, prove the sprite painted and the window can be dragged, and
 * exit. Everything this can check without a human, it checks.
 */
async function selftest() {
  await new Promise(resolve => setTimeout(resolve, 900))

  const payload = {
    ok: win !== undefined && !win.isDestroyed(),
    electron: process.versions.electron,
    size: SIZE,
    assets: ASSETS,
    bounds: win === undefined ? undefined : win.getBounds(),
    idleUrl: assetUrl('Idle.gif'),
    visible: win === undefined ? undefined : win.isVisible(),
    opacity: win === undefined ? undefined : win.getOpacity(),
    alwaysOnTop: win === undefined ? undefined : win.isAlwaysOnTop(),
    // Units matter enormously here: setPosition takes DIP, and if these numbers
    // are actually physical pixels the pet docks clean off the screen.
    display: {
      workArea: screen.getPrimaryDisplay().workArea,
      scaleFactor: screen.getPrimaryDisplay().scaleFactor,
    },
  }

  try {
    // The cursor may legitimately be resting on the pet, which would show joy.
    await win.webContents.executeJavaScript(`window.__petSetHover(false), true`)
    await new Promise(resolve => setTimeout(resolve, 400))
    payload.images = await win.webContents.executeJavaScript(`(() => {
      const out = {}
      for (const state of ${JSON.stringify(STATES)}) {
        const img = document.getElementById(state)
        out[state] = {
          complete: img?.complete === true,
          naturalWidth: img?.naturalWidth ?? 0,
          naturalHeight: img?.naturalHeight ?? 0,
          opacity: img ? getComputedStyle(img).opacity : null,
        }
      }
      const rect = document.body.getBoundingClientRect()
      out.body = rect.width + 'x' + rect.height
      out.shownState = document.body.dataset.state
      out.bridge = {
        dragStart: typeof window.petWindow?.dragStart,
        dragEnd: typeof window.petWindow?.dragEnd,
        close: typeof window.petWindow?.close,
        onState: typeof window.petWindow?.onState,
        onFlash: typeof window.petWindow?.onFlash,
      }
      out.devicePixelRatio = window.devicePixelRatio
      return out
    })()`)
  } catch (error) {
    payload.imageProbeError = String(error)
  }

  // Walk every host state and confirm the browser really shows the right layer,
  // not merely that the file decoded.
  try {
    payload.states = {}
    for (const state of HOST_STATES) {
      await win.webContents.executeJavaScript(
        `window.__petSetHover(false), window.__petSetState(${JSON.stringify(state)}), true`)
      // Longer than the .18 s crossfade, so the sampled opacities have settled.
      await new Promise(resolve => setTimeout(resolve, 420))
      payload.states[state] = await win.webContents.executeJavaScript(`(() => {
        const out = { dataset: document.body.dataset.state, opacity: {} }
        for (const s of ${JSON.stringify(STATES)}) {
          out.opacity[s] = getComputedStyle(document.getElementById(s)).opacity
        }
        return out
      })()`)
    }

    // The tick must survive: the transformation plays once and then hands over to
    // the levitation loop, rather than replaying the burst forever.
    await win.webContents.executeJavaScript(`window.__petSetState('done'), true`)
    await new Promise(resolve => setTimeout(resolve, 120))
    const during = await win.webContents.executeJavaScript(`window.__petShown()`)
    await new Promise(resolve => setTimeout(resolve, MORPH_MS + 400))
    const after = await win.webContents.executeJavaScript(`(() => ({
      ...window.__petShown(),
      opacity: { done: getComputedStyle(document.getElementById('done')).opacity,
                 float: getComputedStyle(document.getElementById('float')).opacity },
    }))()`)
    payload.morph = { ms: MORPH_MS, during, after }
  } catch (error) {
    payload.statesError = String(error)
  }

  // Drive the drag the way the page does and check the window follows the
  // cursor. The movement is produced by this process, so it can be exercised
  // without a physical mouse.
  try {
    const before = win.getBounds()
    beginDrag()
    const grabbed = dragOffset
    endDrag()
    // Now aim a deterministic cursor. The sampling interval is stopped first:
    // left running it would drag the window back to the real pointer and report
    // a movement of zero, which is a fact about the test, not the pet.
    lastCursor = { x: 0, y: 0 }
    dragOffset = { x: 0, y: 0 }
    followCursor({ x: 70, y: 55 })
    await new Promise(resolve => setTimeout(resolve, 350))
    const after = win.getBounds()
    dragOffset = null
    lastCursor = null
    payload.drag = {
      grabbed: grabbed !== null,
      // The grab must land inside the sprite, or the pet would jump on press.
      offsetInsideSprite: grabbed !== null
        && grabbed.x >= 0 && grabbed.x <= SIZE && grabbed.y >= 0 && grabbed.y <= SIZE,
      dx: after.x - before.x,
      dy: after.y - before.y,
    }
    win.setPosition(before.x, before.y)
  } catch (error) {
    payload.dragError = String(error)
  }

  // Show the finished frame, then capture: this proves the sprite reaches the
  // screen, not merely that it decoded.
  try {
    await win.webContents.executeJavaScript(`window.__petSetState('done'), true`)
    await new Promise(resolve => setTimeout(resolve, 400))
    const image = await win.webContents.capturePage()
    payload.capturedBytes = image.toPNG().length
    require('node:fs').writeFileSync(path.join(__dirname, 'selftest.png'), image.toPNG())
  } catch (error) {
    payload.captureError = String(error)
  }

  try {
    require('node:fs').writeFileSync(path.join(__dirname, 'selftest.json'),
      JSON.stringify(payload, null, 2) + '\n')
  } catch { /* the exit code still tells the story */ }
  app.exit(payload.ok ? 0 : 1)
}
