/**
 * Drive the floating pet the way the plugin's host half does, and photograph it.
 *
 * The host starts the app and serves `GET /state`; the app polls it. This stands
 * in for the host so every state — route, poll, IPC, layer switch, waiting mark —
 * can be checked without reloading the running harness.
 *
 * Writes _probe-<state>.png next to this file and prints where the pet landed.
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const ELECTRON = process.env.DSH_ELECTRON ??
  join(homedir(), '.dsh', 'electron', process.platform === 'win32' ? 'electron.exe' : 'electron')
const APP = join(ROOT, 'desktop')
const ASSETS = join(ROOT, 'assets')
const POWERSHELL = process.env.DSH_POWERSHELL ??
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const PORT = Number(process.env.DSH_PROBE_PORT ?? 19399)
const X = Number(process.env.DSH_PROBE_X ?? 500)
const Y = Number(process.env.DSH_PROBE_Y ?? 400)

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** What the stand-in host is currently reporting. */
let current = { state: 'idle', mark: null }

const server = createServer((req, res) => {
  if (req.url?.startsWith('/api/dsh-pet/state')) {
    const body = Buffer.from(JSON.stringify({
      alive: true,
      running: current.state === 'thinking',
      state: current.state,
      mark: current.mark,
      unread: current.state === 'done',
    }))
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(body.length) })
    res.end(body)
    return
  }
  res.writeHead(404)
  res.end()
})
await new Promise(resolve => server.listen(PORT, '127.0.0.1', resolve))

function grab(name) {
  const path = join(HERE, `_probe-${name}.png`)
  const script = [
    'Add-Type -AssemblyName System.Drawing',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$b=[System.Windows.Forms.SystemInformation]::VirtualScreen',
    '$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height',
    '$g=[System.Drawing.Graphics]::FromImage($bmp)',
    '$g.CopyFromScreen($b.X,$b.Y,0,0,(New-Object System.Drawing.Size $b.Width,$b.Height))',
    `$bmp.Save('${path}',[System.Drawing.Imaging.ImageFormat]::Png)`,
    '$g.Dispose(); $bmp.Dispose()',
  ].join('; ')
  return new Promise(resolve => {
    spawn(POWERSHELL, ['-NoProfile', '-Command', script], { stdio: 'ignore' }).on('exit', resolve)
  })
}

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const pet = spawn(ELECTRON, [
  APP,
  '--size=120',
  `--assets=${ASSETS}`,
  `--api=http://127.0.0.1:${PORT}/api/dsh-pet`,
  `--x=${X}`,
  `--y=${Y}`,
], { env, stdio: 'ignore' })
console.log('pet pid', pet.pid)

await sleep(5000)

// `done` is a one-shot 4.3 s transformation, so it is photographed while the
// sparks are still up, and again once the tick has settled into levitation.
const STEPS = [
  { name: 'idle', state: 'idle', mark: null, wait: 1500 },
  { name: 'thinking', state: 'thinking', mark: null, wait: 1500 },
  { name: 'waiting-approval', state: 'waiting', mark: 'approval', wait: 1500 },
  { name: 'waiting-question', state: 'waiting', mark: 'question', wait: 1500 },
  { name: 'waiting-plan', state: 'waiting', mark: 'plan-review', wait: 1500 },
  { name: 'done', state: 'done', mark: null, wait: 2200 },
  { name: 'float', state: 'done', mark: null, wait: 4000 },
]

for (const step of STEPS) {
  current = { state: step.state, mark: step.mark }
  console.log('state ->', step.name)
  await sleep(step.wait)
  await grab(step.name)
}

pet.kill()
server.close()
console.log('done')
