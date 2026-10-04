# tools/

Development and verification helpers. None of this is needed to *use* the pet —
it is here because the interesting bugs in this plugin were all invisible ones,
and these scripts are what made them visible.

| Script | What it does |
|---|---|
| `whale_states.py` | Generates `thinking.gif`, `done.gif` and `float.gif` from a base whale sprite, in the same frame and palette as the shipped animations. |
| `probe_states.mjs` | Runs the desktop app against a stand-in `/state` server and photographs the screen after each state, so the whole chain — route, poll, IPC, layer switch — can be checked without reloading the running harness. |
| `check-window.ps1` | Minimises the harness, clicks the pet, and reports which window ends up in front. Verifies the click and the window-raising in one pass. |
| `find-pet.py` | Locates the sprite inside a screenshot. Used by `check-window.ps1`; confines the search to a region, because the whale's blue occurs in ordinary applications too. |

## Two things that will waste your afternoon

**A full-screen game in the foreground captures the pointer.** `SetCursorPos`
then cannot reach the pet, the click lands on the game, and it looks exactly like
a pet that ignores the mouse. Only the foreground process may release the
capture, so close or minimise the game first.

**A process that is not DPI aware sees a different coordinate space than
`SetCursorPos` uses.** Screenshots come back in physical pixels while the cursor
goes to virtualised ones, and the click lands next to the pet. Both
`check-window.ps1` and its inline C# call `SetProcessDPIAware()` for that reason.

## Requirements

- Python with Pillow and numpy (for `whale_states.py` and `find-pet.py`).
- A plain Electron runtime for `probe_states.mjs` — by default it looks in
  `<home>/.dsh/electron/`; override with `DSH_ELECTRON`.
- PowerShell on Windows for `check-window.ps1`.

```powershell
python tools\whale_states.py path\to\base_sprite.png
node tools\probe_states.mjs
powershell -ExecutionPolicy Bypass -File tools\check-window.ps1
```
