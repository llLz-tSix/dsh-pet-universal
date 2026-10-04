# tools/

Development and verification helpers. None of this is needed to *use* the pet —
it is here because every interesting bug in this plugin was an invisible one, and
these scripts are what made them visible.

| Script | What it does |
|---|---|
| `petart.py` | Shared helpers: sprite loading, eye surgery, bubbles, sparks, dust, palette encoding. |
| `whale_art.py` | Builds every animation and waiting mark from the base whale sprite. |
| `probe_states.mjs` | Runs the desktop app against a stand-in `/state` server and photographs the screen after each state, so the whole chain — route, poll, IPC, layer switch, waiting mark — can be checked without reloading the running harness. |
| `check-window.ps1` | Minimises the harness, clicks the pet, and reports which window ends up in front. Verifies the click and the window-raising in one pass. |
| `find-pet.py` | Locates the sprite inside a screenshot. Used by `check-window.ps1`; confines the search to a region, because the whale's blue occurs in ordinary applications too. |

## Building the art

```powershell
python tools\whale_art.py whale_pixel.png whale_pixel_fountain.png main,crazy
```

The first sprite is the whale with open eyes; the second adds the water jet used
by the joy animation. Both are optional arguments — without them the script looks
for those names next to itself. The third argument lists which looks to build and
defaults to both.

A look is a resting face, not a separate creature. `main` is the drawing as it
came; `crazy` is painted over it — round eyes, a wide toothy grin — and every
expression in that look is built on top, so the grin survives blinking, cheering
and sleeping while only the eyes change. Everything else is shared: the same
bodies, poses and timings, which is why the two sets are the same size and why a
switch between them does not move the pet by a pixel.

Everything is authored on a native 80×80 grid, pasted onto a 120×120 canvas at a
fixed offset, and upscaled ×4 with NEAREST. That framing is the whole point of
having one script: a state built at a different size or offset makes the pet jump
the moment the plugin switches layers, and `test-desktop.mjs` asserts that all ten
sprites come out the same size.

Faces are painted on, not drawn from scratch: the source is a single flat PNG, so
`Whale.face()` floods the eye regions, fills them with the surrounding skin colour
and draws a new arc. That is how the sleeping and contented expressions exist at
all.

## What the generator refuses to do

Two mistakes in this art are invisible in a still frame and obvious in motion, so
neither is left to the eye.

**It will not let the whale leave the frame.** At 77 px across on a 120 px canvas
there is not much room, and an animation that both travels and turns over eats it
quickly — the result is a flat edge on the sprite. `check_inside()` measures the
creature every time it is pasted and stops the build. Decorative bubbles are
exempt on purpose: those are supposed to drift out of frame.

This caught a real bug. The somersault originally needed 47 px of clearance from
the centre while the frame offers 60, so while the whale was rolling it could only
stray thirteen pixels sideways — and a figure-eight thirteen pixels wide is not a
figure-eight. Moving the somersaults to the crossings of the eight, where the path
itself passes near the middle, freed the width for a path three times as wide.

**It will not let the ambient loops drift apart.** They all run at once and are
crossfaded, so a loop of a different length desynchronises the scene and everything
in it teleports on the next switch. The generator compares their lengths and stops
if they disagree.

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

- Python with Pillow and numpy.
- A plain Electron runtime for `probe_states.mjs` — by default it looks in
  `<home>/.dsh/electron/`; override with `DSH_ELECTRON`.
- PowerShell on Windows for `check-window.ps1`; override the interpreter with
  `DSH_POWERSHELL` and the Python with `DSH_PYTHON` if yours live elsewhere.
