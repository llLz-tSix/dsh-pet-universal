"""Generate the extra pet states: thinking, done (whale -> tick) and float.

Every sprite must live in the SAME frame as Idle.gif and alive.gif — native
120x120, whale pasted at (22, 14), scale 6 — or the pet would jump size and
position when the state changes. Same palette too, so the colours never shift.

  thinking.gif  the whale with a pulsing "..." above its head, 2.16 s loop
  done.gif      whale -> burst -> tick drops in, one-shot, 4.32 s
  float.gif     the tick levitating, seamless loop, 2.16 s

Usage:
    python whale_states.py [path/to/base_sprite.png]

The base sprite is the plain whale used for Idle.gif; happy_whale / fountain
variants are not needed here.
"""
import math
import os
import sys
from collections import Counter

from PIL import Image
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, os.pardir, "assets")
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "whale_pixel.png")
OUT_THINKING = os.path.join(ASSETS, "thinking.gif")
OUT_DONE = os.path.join(ASSETS, "done.gif")
OUT_FLOAT = os.path.join(ASSETS, "float.gif")
PREVIEW = os.path.join(HERE, "states_preview.png")

CAN = 120          # native canvas, identical to the other two animations
OFF = (22, 14)     # whale offset, identical to the other two animations
SCALE = 6          # 120 * 6 = 720
MAGENTA = (255, 0, 255)

# The whale's own palette, so nothing shifts hue between states.
BODY = (77, 107, 254, 255)
LIGHT = (160, 186, 250, 255)
PALE = (204, 222, 255, 255)
DARK = (14, 22, 92, 255)
WHITE = (255, 255, 255, 255)

base = Image.open(SRC).convert("RGBA").resize((80, 80), Image.NEAREST)


def blank():
    return Image.new("RGBA", (CAN, CAN), (0, 0, 0, 0))


def whale(canvas, dy=0):
    canvas.alpha_composite(base, (OFF[0], OFF[1] + dy))


def dot(canvas, x, y, colour=LIGHT):
    """A 5x5 pixel dot with a highlight, chunky enough to read at pet size."""
    px = canvas.load()
    for dx in range(5):
        for dy in range(5):
            if 0 <= x + dx < CAN and 0 <= y + dy < CAN:
                px[x + dx, y + dy] = colour
    px[x, y] = WHITE


# ── thinking: pulsing dots above the head ────────────────────────────────────

DOTS = [(43, 21), (52, 21), (61, 21)]
THINK_FRAMES = 36
THINK_DUR = 60


def thinking_frames():
    frames = []
    for t in range(THINK_FRAMES):
        dy = round(2.0 * math.sin(2 * math.pi * t / THINK_FRAMES))
        canvas = blank()
        whale(canvas, dy)
        # The classic indicator: one dot, two, three, then a beat of nothing.
        shown = 0
        if t < 9:
            shown = 1
        elif t < 18:
            shown = 2
        elif t < 27:
            shown = 3
        for i in range(shown):
            dot(canvas, DOTS[i][0], DOTS[i][1])
        frames.append(canvas)
    return frames


# ── done: whale becomes a tick that levitates ────────────────────────────────

DONE_FRAMES = 72
DONE_DUR = 60          # 72 * 60 ms = 4.32 s, played once


def segment_distance(px, py, x0, y0, x1, y1):
    dx, dy = x1 - x0, y1 - y0
    length = dx * dx + dy * dy
    if length == 0:
        return math.hypot(px - x0, py - y0)
    u = max(0.0, min(1.0, ((px - x0) * dx + (py - y0) * dy) / length))
    return math.hypot(px - (x0 + u * dx), py - (y0 + u * dy))


def tick_mask():
    """A chunky tick, drawn as two thick strokes so it stays crisp pixel art."""
    # Short down-stroke, long up-stroke, centred where the whale's body sits.
    strokes = [((32, 62), (47, 79)), ((47, 79), (88, 32))]
    radius = 5.6
    mask = np.zeros((CAN, CAN), dtype=bool)
    for x0, y0 in [strokes[0][0]]:
        pass
    xs = [p[0] for s in strokes for p in s]
    ys = [p[1] for s in strokes for p in s]
    for y in range(max(0, min(ys) - 10), min(CAN, max(ys) + 10)):
        for x in range(max(0, min(xs) - 10), min(CAN, max(xs) + 10)):
            for (a, b), (c, d) in strokes:
                if segment_distance(x, y, a, b, c, d) <= radius:
                    mask[y, x] = True
                    break
    return mask


def draw_tick(canvas, dy=0):
    """Fill, outline and a top-left highlight — the way pixel art shades itself."""
    mask = tick_mask()
    px = canvas.load()

    def inside(x, y):
        return 0 <= x < CAN and 0 <= y < CAN and mask[y, x]

    for y in range(CAN):
        for x in range(CAN):
            if inside(x, y):
                # Upper-left rim catches the light.
                if not inside(x - 1, y - 1):
                    px[x, y + dy] = LIGHT if 0 <= y + dy < CAN else px[x, y + dy]
                else:
                    px[x, y + dy] = BODY if 0 <= y + dy < CAN else px[x, y + dy]
            elif (inside(x - 1, y) or inside(x + 1, y) or inside(x, y - 1) or inside(x, y + 1)):
                if 0 <= y + dy < CAN:
                    px[x, y + dy] = DARK


def burst(canvas, radius, colour):
    """A dotted ring of sparks expanding away from where the whale was."""
    cx, cy = 60, 58
    px = canvas.load()
    steps = max(12, int(2 * math.pi * radius))
    for i in range(steps):
        angle = 2 * math.pi * i / steps
        if i % 2:
            continue
        x = int(round(cx + radius * math.cos(angle)))
        y = int(round(cy + radius * math.sin(angle)))
        if 0 <= x < CAN and 0 <= y < CAN:
            px[x, y] = colour


SPARKLES = [(30, 26, 14, 0), (92, 74, 14, 5), (36, 78, 18, 9), (86, 22, 18, 2)]


def done_frames():
    frames = []
    for t in range(DONE_FRAMES):
        canvas = blank()

        if t <= 5:
            # A last breath as the work lands.
            whale(canvas, round(2.0 * math.sin(2 * math.pi * t / 12)))
        elif t <= 7:
            # The whale is gone; sparks carry the eye instead of a fade, which a
            # 1-bit alpha GIF cannot express anyway.
            burst(canvas, 9 if t == 6 else 18, WHITE if t == 6 else PALE)
        elif t <= 17:
            # The tick drops in and settles with a small overshoot.
            fall = {8: -34, 9: -27, 10: -20, 11: -13, 12: -7, 13: -2, 14: 3, 15: 0, 16: -1, 17: 0}
            draw_tick(canvas, fall.get(t, 0))
        else:
            # Levitating like a dropped item: a slow bob, plus the odd sparkle.
            dy = round(3.0 * math.sin(2 * math.pi * (t - 17) / 36))
            draw_tick(canvas, dy)
            for x, y, period, offset in SPARKLES:
                if ((t - offset) % period) < 3 and 0 <= y < CAN:
                    canvas.load()[x, y] = WHITE
        frames.append(canvas)
    return frames


# ── float: the tick alone, bobbing forever ───────────────────────────────────

FLOAT_FRAMES = 36
FLOAT_DUR = 60          # 2.16 s, an exact number of bob periods, so it loops clean


def float_frames():
    """The tick mid-levitation, for as long as the pet stays on "done".

    The transformation is a one-shot: replaying it every few seconds would have
    the whale burst into sparks over and over while the user is still reading.
    So the finished state gets its own seamless loop, and `done.gif` is played
    exactly once before this takes over.
    """
    frames = []
    for t in range(FLOAT_FRAMES):
        canvas = blank()
        dy = round(3.0 * math.sin(2 * math.pi * t / FLOAT_FRAMES))
        draw_tick(canvas, dy)
        for x, y, period, offset in SPARKLES:
            if ((t - offset) % period) < 3 and 0 <= y < CAN:
                canvas.load()[x, y] = WHITE
        frames.append(canvas)
    return frames


# ── encode ───────────────────────────────────────────────────────────────────

def save(frames, path, duration):
    rgba = [f.resize((CAN * SCALE, CAN * SCALE), Image.NEAREST) for f in frames]
    keys = set()
    flat = []
    for f in rgba:
        bg = Image.new("RGB", f.size, MAGENTA)
        bg.paste(f, (0, 0), f)
        a = np.array(bg)
        flat.append(a)
        keys.update(np.unique((a[..., 0].astype(np.uint32) << 16) |
                              (a[..., 1].astype(np.uint32) << 8) | a[..., 2]).tolist())
    colours = [MAGENTA] + [(k >> 16 & 255, k >> 8 & 255, k & 255)
                           for k in sorted(keys) if k != (255 << 16 | 255)]
    palette = []
    for i in range(256):
        r, g, b = colours[i] if i < len(colours) else (0, 0, 0)
        palette += [r, g, b]
    lookup = np.zeros(1 << 24, dtype=np.uint8)
    for i, (r, g, b) in enumerate(colours):
        lookup[(r << 16) | (g << 8) | b] = i
    out = []
    for a in flat:
        packed = ((a[..., 0].astype(np.uint32) << 16) | (a[..., 1].astype(np.uint32) << 8) | a[..., 2])
        im = Image.fromarray(lookup[packed], "P")
        im.putpalette(palette)
        out.append(im)
    out[0].save(path, save_all=True, append_images=out[1:], duration=duration,
                loop=0, transparency=0, disposal=2, optimize=False)
    print("saved", path, len(out), "frames,", len(colours), "colours")


thinking = thinking_frames()
done = done_frames()
floating = float_frames()
save(thinking, OUT_THINKING, THINK_DUR)
save(done, OUT_DONE, DONE_DUR)
save(floating, OUT_FLOAT, FLOAT_DUR)

# ── preview strip ────────────────────────────────────────────────────────────
# Row 1 walks the thinking loop; rows 2-3 walk the whole done sequence, so the
# transformation can be judged at a glance instead of by playing the GIF.
TILE = 180
COLS = 6
PICKS = ([("t", i) for i in (0, 6, 12, 18, 24, 30)]
         + [("d", i) for i in (0, 4, 6, 7, 9, 10, 11, 13, 15, 22, 36, 52)])
SOURCES = {"t": thinking, "d": done}
ROWS = (len(PICKS) + COLS - 1) // COLS
strip = Image.new("RGB", (COLS * TILE, ROWS * TILE), (18, 26, 54))
for i, (kind, index) in enumerate(PICKS):
    cell = Image.new("RGB", (CAN, CAN), (18, 26, 54))
    cell.paste(SOURCES[kind][index], (0, 0), SOURCES[kind][index])
    strip.paste(cell.resize((TILE, TILE), Image.NEAREST),
                ((i % COLS) * TILE, (i // COLS) * TILE))
strip.save(PREVIEW)
print("preview:", PREVIEW, f"{COLS}x{ROWS}")
