"""Build every pet animation from the base whale sprite.

One script for all states, because they share a frame, a palette and a set of
helpers — generating them separately is how the pet ends up jumping in size when
it changes state.

    python whale_art.py [plain.png] [fountain.png]

`plain.png` is the whale with open eyes. `fountain.png` is the same whale with a
water jet out of its blowhole, used by the joy animation.
"""
import math
import os
import sys

import numpy as np
from PIL import Image

from petart import (CAN, OFF, PIVOT, SCALE, C_MID, C_PALE, C_SOFT, DARK, LIGHT, WHITE,
                    BODY, Whale, blank, dot, dust, load_sprite, ring, save,
                    save_mark, stamp_bubbles)

HERE = os.path.dirname(os.path.abspath(__file__))
PLAIN = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "whale_pixel.png")
FOUNTAIN = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, "whale_pixel_fountain.png")

whale = Whale(load_sprite(PLAIN),
              load_sprite(FOUNTAIN) if os.path.exists(FOUNTAIN) else None)
print("eye boxes:", whale.eyes, "| skin:", whale.skin)

# Attention colour. The harness paints a waiting session with its own "warning"
# accent, so the pet asks for the user in the same colour rather than inventing
# one — the mark reads as part of the same product.
AMBER = (255, 200, 64, 255)


def glyph(rows, colour, outline=(24, 18, 8, 255)):
    """Turn a small character map into (x, y, colour) pixels, with a dark outline.

    The outline is baked in rather than left to CSS: the pet sits over whatever
    the desktop happens to show, and a bare amber glyph disappears against a
    light window. One dark pixel of padding keeps it legible either way, and it
    costs nothing because the glyphs are four pixels per cell.
    """
    body = {(x, y) for y, row in enumerate(rows)
            for x, cell in enumerate(row) if cell == "#"}
    pixels = []
    for (x, y) in body:
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            if (x + dx, y + dy) not in body:
                pixels.append((x + dx + 1, y + dy + 1, outline))
    pixels += [(x + 1, y + 1, colour) for (x, y) in body]
    return pixels


# --------------------------------------------------------------- the marks
# Three kinds of waiting, three glyphs. Drawn at 1:1 and scaled up by CSS with
# pixelated rendering, so they stay crisp without shipping three animations.
APPROVAL = [
    ".###.",
    ".###.",
    ".###.",
    ".###.",
    ".###.",
    ".###.",
    ".....",
    ".###.",
    ".###.",
]
QUESTION = [
    ".#####.",
    "##...##",
    "##...##",
    ".....##",
    "....##.",
    "..###..",
    "..##...",
    ".......",
    "..###..",
    "..###..",
]
PLAN = [
    "..###..",
    ".#####.",
    ".#...#.",
    ".#...#.",
    ".#...#.",
    ".#...#.",
    ".#...#.",
    ".#####.",
]


# ------------------------------------------------------------ the tick mark
def segment_distance(px, py, x0, y0, x1, y1):
    dx, dy = x1 - x0, y1 - y0
    length = dx * dx + dy * dy
    if length == 0:
        return math.hypot(px - x0, py - y0)
    u = max(0.0, min(1.0, ((px - x0) * dx + (py - y0) * dy) / length))
    return math.hypot(px - (x0 + u * dx), py - (y0 + u * dy))


TICK_STROKES = [((32, 62), (47, 79)), ((47, 79), (88, 32))]
TICK_RADIUS = 5.6


def tick_mask():
    mask = np.zeros((CAN, CAN), dtype=bool)
    for y in range(CAN):
        for x in range(CAN):
            for (a, b), (c, d) in TICK_STROKES:
                if segment_distance(x, y, a, b, c, d) <= TICK_RADIUS:
                    mask[y, x] = True
                    break
    return mask


TICK = tick_mask()


def draw_tick(canvas, dy=0):
    pixels = canvas.load()

    def inside(x, y):
        return 0 <= x < CAN and 0 <= y < CAN and TICK[y, x]

    for y in range(CAN):
        for x in range(CAN):
            if not 0 <= y + dy < CAN:
                continue
            if inside(x, y):
                # The upper-left rim catches the light; everything else is body.
                pixels[x, y + dy] = LIGHT if not inside(x - 1, y - 1) else BODY
            elif inside(x - 1, y) or inside(x + 1, y) or inside(x, y - 1) or inside(x, y + 1):
                pixels[x, y + dy] = DARK


# Sparkle periods must divide the loop length exactly, or the twinkles jump at
# the seam: 36/14 leaves a remainder, so the pattern restarted mid-flicker and
# the tick looked like it was glitching once per cycle.
SPARKLES = [(30, 26, 12, 0), (92, 74, 12, 5), (36, 78, 18, 9), (86, 22, 18, 2)]


# ------------------------------------------------------------------- idle
IDLE_FRAMES, IDLE_DUR = 36, 60


def idle_frames():
    frames = []
    for t in range(IDLE_FRAMES):
        phase = t / IDLE_FRAMES
        dy = round(2.0 * math.sin(2 * math.pi * phase))
        # One blink, four frames long, at t = 20..23.
        mode = {20: "half", 21: "closed", 22: "closed", 23: "half"}.get(t, "open")
        canvas = blank()
        stamp_bubbles(canvas, phase, front=False)
        whale.place(canvas, whale.face(mode), dy=dy)
        stamp_bubbles(canvas, phase, front=True)
        frames.append(canvas)
    return frames


# ------------------------------------------------------- idle: big bubble
# Same length and the same ambient-bubble phase as the plain loop. When the two
# differed, switching between them teleported every bubble in the scene, because
# the layers are crossfaded while both keep running.
FOAM_FRAMES, FOAM_DUR = 36, 60


def foam_frames():
    """The whale blows one big bubble that climbs, wobbles and pops.

    The plain loop is identical every 2.16 s, which starts reading as a looping
    GIF rather than a creature. This variant is the same scene with one event in
    it, so the pet can pick between them at random and never look mechanical.
    """
    frames = []
    cx, cy = 28 + OFF[0], 28 + OFF[1]
    for t in range(FOAM_FRAMES):
        phase = t / FOAM_FRAMES
        dy = round(2.0 * math.sin(2 * math.pi * phase))
        # A small flinch when the bubble pops.
        if 26 <= t <= 29:
            dy += (2, 3, 1, 0)[t - 26]
        canvas = blank()
        stamp_bubbles(canvas, phase, front=False)

        if 5 <= t <= 31:
            growth = min(1.0, (t - 5) / 11.0)
            climb = (t - 5) / 26.0
            radius = 2 + 5 * growth
            x = int(round(cx + 3 * math.sin(2 * math.pi * climb * 1.5)))
            y = int(round(cy - 6 - climb * 34))
            bubble = Image.new("RGBA", (CAN, CAN), (0, 0, 0, 0))
            pixels = bubble.load()
            steps = max(12, int(2 * math.pi * radius * 2))
            for i in range(steps):
                angle = 2 * math.pi * i / steps
                bx = int(round(x + radius * math.cos(angle)))
                by = int(round(y + radius * math.sin(angle)))
                if 0 <= bx < CAN and 0 <= by < CAN:
                    pixels[bx, by] = C_SOFT if i % 7 else WHITE
            canvas.alpha_composite(bubble)
            whale.place(canvas, whale.face("open"), dy=dy)
        elif 32 <= t <= 35:
            whale.place(canvas, whale.face("open"), dy=dy)
            ring(canvas, 6 + (t - 32) * 2, WHITE if t < 34 else C_PALE,
                 centre=(cx, cy - 40), step=3)
        else:
            whale.place(canvas, whale.face("open"), dy=dy)

        stamp_bubbles(canvas, phase, front=True)
        frames.append(canvas)
    return frames


# ---------------------------------------------------------------- thinking
THINK_FRAMES, THINK_DUR = 36, 60
THINK_DOTS = [(43, 21), (52, 21), (61, 21)]


def thinking_frames():
    frames = []
    for t in range(THINK_FRAMES):
        dy = round(2.0 * math.sin(2 * math.pi * t / THINK_FRAMES))
        canvas = blank()
        pose = whale.face("open")
        # Eyes narrow slightly mid-thought, as if squinting at the problem.
        if 9 <= t <= 26:
            pose = whale.face("half")
        whale.place(canvas, pose, dy=dy)
        shown = 0
        if t < 9:
            shown = 1
        elif t < 18:
            shown = 2
        elif t < 27:
            shown = 3
        for i in range(shown):
            dot(canvas, THINK_DOTS[i][0], THINK_DOTS[i][1])
        frames.append(canvas)
    return frames


# ----------------------------------------------------------------- waiting
WAIT_FRAMES, WAIT_DUR = 36, 60


def waiting_frames():
    """Body language for "I need you": a two-beat bounce with a forward lean.

    The glyph above the head is a separate overlay drawn by the page, because the
    three kinds of waiting share this pose and only differ in the mark.
    """
    frames = []
    for t in range(WAIT_FRAMES):
        # Two eager hops per loop, with the squash that makes them read as effort.
        beat = (t % 18) / 18.0
        hop = max(0.0, math.sin(math.pi * min(1.0, beat * 2.6)))
        dy = -round(4 * hop)
        squash = 1.0 + 0.10 * hop
        stretch = 1.0 - 0.10 * hop
        canvas = blank()
        whale.place(canvas, whale.face("open"), angle=-4.0 * hop,
                    dy=dy, squash=squash, stretch=stretch)
        frames.append(canvas)
    return frames


# ------------------------------------------------------------------- sleep
SLEEP_FRAMES, SLEEP_DUR = 48, 80
SLEEP_Z = [(70, 30, 4), (78, 20, 3)]


def zed(canvas, x, y, size, colour=C_PALE):
    """A tiny Z, drawn as three strokes."""
    pixels = canvas.load()
    for i in range(size):
        for (px, py) in ((x + i, y), (x + size - 1 - i, y + size - 1),
                         (x + i, y + size - 1)):
            if 0 <= px < CAN and 0 <= py < CAN:
                pixels[px, py] = colour


def sleep_frames():
    frames = []
    for t in range(SLEEP_FRAMES):
        # Slower and deeper than the waking bob, so sleep is visible at a glance.
        dy = round(3.0 * math.sin(2 * math.pi * t / SLEEP_FRAMES))
        canvas = blank()
        whale.place(canvas, whale.face("closed"), dy=dy)
        for i, (zx, zy, size) in enumerate(SLEEP_Z):
            # Each Z rises and fades on its own offset, so they trail each other.
            phase = ((t / SLEEP_FRAMES) + i * 0.5) % 1.0
            if phase < 0.85:
                zed(canvas, zx - int(phase * 6), zy - int(phase * 12), size,
                    C_PALE if phase < 0.5 else C_SOFT)
        frames.append(canvas)
    return frames


# -------------------------------------------------------------------- held
HELD_FRAMES, HELD_DUR = 12, 50


def held_frames():
    """Picked up: stretched, hanging, and wriggling a little."""
    frames = []
    for t in range(HELD_FRAMES):
        wobble = math.sin(2 * math.pi * t / HELD_FRAMES)
        canvas = blank()
        whale.place(canvas, whale.face("open"), angle=3.5 * wobble, dy=-2,
                    squash=0.94, stretch=1.08)
        frames.append(canvas)
    return frames


# -------------------------------------------------------------------- drop
DROP_FRAMES, DROP_DUR = 18, 50


def drop_frames():
    """Let go: a squash on impact, a rebound, and a puff of dust. Plays once."""
    frames = []
    for t in range(DROP_FRAMES):
        squash, stretch, dy = 1.0, 1.0, 0
        if t == 0:
            squash, stretch = 1.20, 0.78
        elif t == 1:
            squash, stretch = 1.12, 0.90
        elif t == 2:
            squash, stretch = 0.96, 1.06
        elif t == 3:
            squash, stretch, dy = 0.98, 1.02, -2
        elif t == 4:
            squash, stretch, dy = 1.03, 0.98, 0
        elif t in (5, 6):
            dy = (-1, 0)[t - 5]
        canvas = blank()
        whale.place(canvas, whale.face("open"), dy=dy, squash=squash, stretch=stretch)
        if t <= 5:
            dust(canvas, t / 5.0)
        frames.append(canvas)
    return frames


# -------------------------------------------------------------------- done
DONE_FRAMES, DONE_DUR = 72, 60


def done_frames():
    """One-shot: a last breath, a burst of sparks, the tick drops in."""
    frames = []
    for t in range(DONE_FRAMES):
        canvas = blank()
        if t <= 5:
            whale.place(canvas, whale.face("happy"), dy=round(2.0 * math.sin(2 * math.pi * t / 12)))
        elif t <= 7:
            ring(canvas, 9 if t == 6 else 18, WHITE if t == 6 else C_PALE)
        elif t <= 17:
            fall = {8: -34, 9: -27, 10: -20, 11: -13, 12: -7, 13: -2, 14: 3, 15: 0, 16: -1, 17: 0}
            draw_tick(canvas, fall.get(t, 0))
        else:
            dy = round(3.0 * math.sin(2 * math.pi * (t - 17) / 36))
            draw_tick(canvas, dy)
            for x, y, period, offset in SPARKLES:
                if ((t - offset) % period) < 3 and 0 <= y < CAN:
                    canvas.load()[x, y] = WHITE
        frames.append(canvas)
    return frames


# ------------------------------------------------------------------- float
FLOAT_FRAMES, FLOAT_DUR = 36, 60


def float_frames():
    """The tick alone, levitating. Seamless, because the pet stays on it."""
    frames = []
    for t in range(FLOAT_FRAMES):
        canvas = blank()
        draw_tick(canvas, round(3.0 * math.sin(2 * math.pi * t / FLOAT_FRAMES)))
        for x, y, period, offset in SPARKLES:
            if ((t - offset) % period) < 3 and 0 <= y < CAN:
                canvas.load()[x, y] = WHITE
        frames.append(canvas)
    return frames


# --------------------------------------------------------------------- joy
JOY_FRAMES, JOY_DUR = 54, 40
# A wide, tall eight. The whale is 77 px across on a 120 px canvas, so while it
# is merely banked there are sixteen pixels of travel available each way.
JOY_AX, JOY_AY = 15.0, 26.0
# Where the somersaults happen, as a fraction of the loop, and how long each one
# takes. They sit at the crossing: rolling needs 47 px of clearance from the
# centre and the frame only offers 60, so the whale can only turn over where the
# path itself passes near the middle. Two turns per loop is also a whole number,
# which is what keeps the loop seamless.
JOY_SPIN = 0.075
JOY_SPINS = (-JOY_SPIN, 0.5 - JOY_SPIN)
# How far the body banks at the apexes. A fish leans into the turn, but the
# lean is expensive: it is the lean, not the width of the path, that uses up the
# clearance the somersault needs, so it stays small.
JOY_TILT = 6.0


def joy_path(t):
    """Where the whale is on its figure-eight, in canvas pixels from centre."""
    theta = 2 * math.pi * t / JOY_FRAMES
    return JOY_AX * math.sin(theta), (JOY_AY / 2.0) * math.sin(2 * theta)


def joy_roll(u):
    """Rotation, in degrees, at a point in the loop.

    The distance is taken modulo a whole loop, not modulo the half-loop between
    the two crossings: the two windows are exactly half a loop apart, so a
    half-loop modulus collapses them into one and counts every somersault twice,
    which spins the whale far faster than intended and throws it out of frame.
    """
    total = 0.0
    for centre in JOY_SPINS:
        d = ((u - centre + 0.5) % 1.0) - 0.5
        if abs(d) < JOY_SPIN:
            k = (d + JOY_SPIN) / (2 * JOY_SPIN)
            # Smoothstep-like, so the turn eases in and out instead of starting
            # and stopping abruptly.
            total += 360.0 * (k - math.sin(2 * math.pi * k) / (2 * math.pi))
    return total


def joy_frames():
    """A somersault shaped like an eight.

    The whale used to spin on the spot and hop off it, which read as a sprite
    being rotated rather than a creature moving. Now it swims the crossing of a
    lemniscate — the path of a fish turning — and somersaults twice per loop,
    once at each crossing, where it has the room.

    The first frame is the neutral pose: centred, upright, unbanked. That is what
    makes the crossfade in from resting invisible.
    """
    frames = []
    wake = []
    for t in range(JOY_FRAMES):
        u = t / JOY_FRAMES
        theta = 2 * math.pi * u
        x, y = joy_path(t)
        angle = -joy_roll(u) + JOY_TILT * math.sin(2 * theta)
        # Two short spouts, timed to the fastest part of the path.
        growth = max(0.0, math.sin(2 * theta)) * 0.8

        canvas = blank()

        # A wake of specks left along the path, so the movement has a trail.
        wake.append((x, y))
        if len(wake) > 18:
            wake.pop(0)
        pixels = canvas.load()
        for i, (wx, wy) in enumerate(wake[:-1]):
            if i % 2:
                continue
            px = int(round(60 + wx))
            py = int(round(60 + wy))
            if 0 <= px < CAN and 0 <= py < CAN:
                age = (len(wake) - 1 - i) / 17.0
                pixels[px, py] = C_PALE if age < 0.45 else (C_SOFT if age < 0.8 else C_MID)

        whale.place(canvas, whale.face("happy"), angle, round(y), dx=round(x))
        if growth > 0:
            whale.place(canvas, whale.jet(growth), angle, round(y), dx=round(x))
        frames.append(canvas)
    return frames


# ----------------------------------------------------------------- generate
# Length of every ambient loop, so they can be checked against each other. They
# all have to be the same: the layers run continuously and are crossfaded, so a
# loop of a different length drifts out of step with the others and whatever the
# scene contains — bubbles, sparkles — visibly teleports when the pet switches.
AMBIENT_MS = {}
save(idle_frames(), "Idle.gif", IDLE_DUR, preview=[0, 6, 12, 18, 21, 30], ambient=AMBIENT_MS)
save(foam_frames(), "idle-bubble.gif", FOAM_DUR, preview=[0, 8, 15, 22, 27, 33], ambient=AMBIENT_MS)
save(joy_frames(), "alive.gif", JOY_DUR, preview=[0, 10, 22, 33, 40, 50], ambient=AMBIENT_MS)
save(thinking_frames(), "thinking.gif", THINK_DUR, preview=[0, 9, 18, 27, 30, 33], ambient=AMBIENT_MS)
save(waiting_frames(), "waiting.gif", WAIT_DUR, preview=[0, 4, 9, 13, 18, 22], ambient=AMBIENT_MS)
save(float_frames(), "float.gif", FLOAT_DUR, preview=[0, 6, 12, 18, 24, 30], ambient=AMBIENT_MS)

# Sleep and the one-shot events are deliberately a different length: a slow bob
# is the point of dozing off, and the transformation must not be cut short.
save(sleep_frames(), "sleep.gif", SLEEP_DUR, preview=[0, 8, 16, 24, 32, 40])
save(held_frames(), "held.gif", HELD_DUR, preview=[0, 2, 4, 6, 8, 10])
save(drop_frames(), "drop.gif", DROP_DUR, preview=[0, 1, 2, 3, 5, 9])
save(done_frames(), "done.gif", DONE_DUR, preview=[0, 4, 6, 7, 12, 20])

lengths = set(AMBIENT_MS.values())
if len(lengths) != 1:
    raise SystemExit(f"ambient loops differ in length and will drift apart: {AMBIENT_MS}")
print("ambient loops all %d ms: %s" % (lengths.pop(), ", ".join(sorted(AMBIENT_MS))))

save_mark("mark-approval.png", glyph(APPROVAL, AMBER))
save_mark("mark-question.png", glyph(QUESTION, AMBER))
save_mark("mark-plan.png", glyph(PLAN, AMBER))
print("done")
