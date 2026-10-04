/**
 * Drive the floating pet the way the plugin's host half does, and photograph it.
 *
 * The host starts the app and serves `GET /state`; the app polls it. This stands
 * in for the host so the whole chain — state route, poll, IPC, layer switch —
 * can be checked without reloading the running DSH.
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
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const PORT = 19399
const X = 500
const Y = 400

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

let current = 'idle'

const server = createServer((req, res) => {
  if (req.url?.startsWith('/api/dsh-pet/state')) {
    const body = Buffer.from(JSON.stringify({ alive: true, running: current === 'thinking', state: current }))
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(body.length) })
    res.end(body)
    return
  }
  res.writeHead(404)
  res.end()
})
await new Promise(resolve => server.listen(PORT, '127.0.0.1', resolve))

function grab(name) {
  const path = join(HERE, `_probe_${name}.png`)
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
await grab('idle')

for (const state of ['thinking', 'done', 'joy']) {
  current = state
  console.log('state ->', state)
  // `done` is a one-shot 4.3 s sequence; catch it while the tick is up.
  await sleep(state === 'done' ? 2600 : 1600)
  await grab(state)
}

pet.kill()
server.close()
console.log('done')
