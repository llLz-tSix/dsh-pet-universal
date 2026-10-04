"""Shared helpers for building the pet's pixel-art animations.

Everything is authored on a native 80x80 sprite grid and pasted onto a 120x120
canvas at a fixed offset, then upscaled with NEAREST. That framing is not a
detail: every state must land in exactly the same place, or the pet jumps in
size and position when the plugin switches sprites.

Output scale is 4, i.e. 480x480. The pet is 120 CSS px by default, which is 240
physical pixels on a 200% display, so 480 has room to spare at twice the size
while keeping the GIFs roughly half the weight of a 720 build.
"""
import math
import os
from collections import deque

import numpy as np
from PIL import Image, ImageDraw

SRC = 80                                  # native sprite grid
CAN = 120                                 # native canvas, shared by every state
SCALE = 4                                 # 120 * 4 = 480 output
OFF = (22, 14)                            # sprite offset inside the canvas
PIVOT = (60.5, 60.5)                      # rotation centre = whale body centre
BLOWHOLE = (28.5, 28.5)                   # in sprite coordinates
MAGENTA = (255, 0, 255)                   # transparent slot in the GIF palette

# One palette for every state, so nothing shifts hue when the sprite changes.
WHITE = (255, 255, 255, 255)
C_BOLD = (92, 120, 255, 255)
C_MID = (124, 154, 242, 255)
C_SOFT = (160, 186, 250, 255)
C_PALE = (204, 222, 255, 255)
BODY = (77, 107, 254, 255)
LIGHT = (160, 186, 250, 255)
DARK = (14, 22, 92, 255)
EYE_DARK = (12, 18, 64, 255)

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, os.pardir, "assets")


def load_sprite(path):
    """Load a source PNG and reduce it to the native 80x80 grid."""
    image = Image.open(path).convert("RGBA")
    if image.size != (SRC, SRC):
        image = image.resize((SRC, SRC), Image.NEAREST)
    return image


def blank():
    return Image.new("RGBA", (CAN, CAN), (0, 0, 0, 0))


class Whale:
    """The base sprite plus what the animations need to know about its face.

    Eye surgery is done by painting over the pupils with the surrounding skin
    colour and drawing a new arc, because the source is a single flat PNG with no
    layers. The eye boxes are found by flood fill rather than hard-coded, so a
    replacement sprite with slightly different eyes still works.
    """

    def __init__(self, plain, fountain=None):
        self.plain = plain
        self.fountain = fountain
        self.eyes = [self._blob((10, 49)), self._blob((30, 49))]
        self.skin = self._skin()
        self._faces = {}
        self._fountain_pixels()

    # -- geometry ---------------------------------------------------------
    def _blob(self, seed):
        array = np.array(self.plain)
        dark = (array[..., :3].astype(int).sum(axis=2) < 200) & (array[..., 3] > 0)
        seen, queue, points = {seed}, deque([seed]), []
        while queue:
            x, y = queue.popleft()
            if not dark[y, x]:
                continue
            points.append((x, y))
            for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if 0 <= nx < SRC and 0 <= ny < SRC and (nx, ny) not in seen and dark[ny, nx]:
                    seen.add((nx, ny))
                    queue.append((nx, ny))
        xs = [p[0] for p in points]
        ys = [p[1] for p in points]
        return (min(xs), min(ys), max(xs), max(ys))

    def _skin(self):
        """The colour surrounding the eyes, sampled rather than assumed."""
        array = np.array(self.plain)
        counts = {}
        for (x0, y0, x1, y1) in self.eyes:
            for y in range(max(0, y0 - 3), min(SRC, y1 + 4)):
                for x in range(max(0, x0 - 3), min(SRC, x1 + 4)):
                    colour = tuple(int(v) for v in array[y, x])
                    if colour[3] == 0 or sum(colour[:3]) < 200:
                        continue
                    counts[colour] = counts.get(colour, 0) + 1
        return max(counts, key=counts.get)

    def _fountain_pixels(self):
        """The jet, as (x, y, colour, distance from the blowhole)."""
        self.fountain_pixels = []
        self.fountain_max = 0.0
        if self.fountain is None:
            return
        plain, fount = np.array(self.plain), np.array(self.fountain)
        mask = (plain != fount).any(axis=2)
        distances = []
        for y in range(SRC):
            for x in range(SRC):
                if mask[y, x]:
                    distance = math.hypot(x - BLOWHOLE[0], y - BLOWHOLE[1])
                    self.fountain_pixels.append((x, y, tuple(int(v) for v in fount[y, x]), distance))
                    distances.append(distance)
        self.fountain_max = max(distances) if distances else 0.0

    # -- faces ------------------------------------------------------------
    def face(self, mode):
        """open | half | closed (a sleepy arc) | happy (a contented arc)."""
        if mode in self._faces:
            return self._faces[mode]
        if mode == "open":
            self._faces[mode] = self.plain
            return self.plain

        image = self.plain.copy()
        draw = ImageDraw.Draw(image)
        for (x0, y0, x1, y1) in self.eyes:
            height = y1 - y0 + 1
            if mode == "half":
                draw.rectangle([x0, y0, x1, y0 + max(1, round(height * 0.55)) - 1], fill=self.skin)
            else:
                draw.rectangle([x0, y0, x1, y1], fill=self.skin)
                row = y0 + height // 2
                span = max(1, (x1 - 1) - (x0 + 1))
                for i, x in enumerate(range(x0 + 1, x1)):
                    t = i / span
                    if mode == "happy":
                        dy = 0 if 0.25 <= t <= 0.75 else 1        # shallow, content
                    else:
                        dy = 0 if 0.2 <= t <= 0.8 else -1         # closed, asleep
                    draw.point((x, row + dy), fill=EYE_DARK)
        self._faces[mode] = image
        return image

    # -- drawing ----------------------------------------------------------
    def place(self, canvas, sprite, angle=0.0, dy=0, dx=0, squash=1.0, stretch=1.0):
        """Paste the sprite, optionally rotated and squashed.

        Squash and stretch are applied at the native grid with NEAREST, which is
        how pixel art fakes weight — a smooth resample would blur the pixels and
        stop reading as the same sprite.
        """
        body = sprite
        if squash != 1.0 or stretch != 1.0:
            width = max(1, round(SRC * squash))
            height = max(1, round(SRC * stretch))
            body = sprite.resize((width, height), Image.NEAREST)
            dx += (SRC - width) // 2
            dy += SRC - height                       # keep the feet planted
        layer = Image.new("RGBA", (CAN, CAN), (0, 0, 0, 0))
        layer.paste(body, (OFF[0] + dx, OFF[1] + dy))
        if angle:
            layer = layer.rotate(angle, resample=Image.NEAREST, center=PIVOT,
                                 fillcolor=(0, 0, 0, 0))
        canvas.alpha_composite(layer)

    def jet(self, growth):
        """The water jet, grown radially out of the blowhole."""
        layer = blank()
        if growth <= 0 or self.fountain is None:
            return layer
        pixels = layer.load()
        threshold = growth * (self.fountain_max + 0.6)
        for x, y, colour, distance in self.fountain_pixels:
            if distance <= threshold:
                pixels[x, y] = colour
        return layer


# -- bubbles ----------------------------------------------------------------
BUBBLES = [
    (4, 0.00, 3, 150, 2, 1, False, C_SOFT),
    (12, 0.42, 2, 120, 1, 2, False, C_BOLD),
    (19, 0.70, 4, 160, 2, 1, False, C_MID),
    (28, 0.12, 2, 130, 1, 1, False, C_SOFT),
    (33, 0.55, 3, 145, 2, 2, False, C_BOLD),
    (41, 0.85, 2, 115, 1, 1, False, C_MID),
    (47, 0.28, 5, 165, 3, 1, False, C_MID),
    (55, 0.62, 2, 135, 1, 2, False, C_BOLD),
    (60, 0.05, 3, 150, 2, 1, False, C_SOFT),
    (68, 0.38, 4, 125, 2, 2, False, C_MID),
    (74, 0.78, 2, 160, 1, 1, False, C_SOFT),
    (63, 0.92, 3, 140, 2, 1, False, C_BOLD),
    (23, 0.65, 2, 150, 1, 1, True, C_MID),
    (37, 0.35, 2, 120, 1, 2, True, C_BOLD),
    (50, 0.80, 3, 160, 2, 1, True, C_SOFT),
    (64, 0.15, 3, 130, 2, 2, True, C_MID),
]


def bubble_pixels(x, y, size):
    if size == 2:
        return [(x + 1, y, 1), (x, y, 0), (x, y + 1, 0), (x + 1, y + 1, 0)]
    if size == 3:
        return [(x + 1, y, 1), (x, y + 1, 0), (x + 2, y + 1, 0), (x + 1, y + 2, 0)]
    if size == 4:
        return [(x + 1, y, 1), (x + 2, y, 0), (x, y + 1, 0), (x + 3, y + 1, 0),
                (x, y + 2, 0), (x + 3, y + 2, 0), (x + 1, y + 3, 0), (x + 2, y + 3, 0)]
    return [(x + 1, y, 1), (x + 2, y, 0), (x + 3, y, 0),
            (x, y + 1, 0), (x + 4, y + 1, 0),
            (x, y + 2, 0), (x + 4, y + 2, 0),
            (x, y + 3, 0), (x + 4, y + 3, 0),
            (x + 1, y + 4, 0), (x + 2, y + 4, 0), (x + 3, y + 4, 0)]


def stamp_bubbles(canvas, phase, front, offset=OFF):
    pixels = canvas.load()
    for (bx, bubble_phase, size, travel, sway, k, is_front, colour) in BUBBLES:
        if is_front != front:
            continue
        p = (phase + bubble_phase) % 1.0
        y = round(86 - p * travel) + offset[1]
        x = bx + offset[0] + round(sway * math.sin(2 * math.pi * (k * p + bubble_phase)))
        for (px, py, kind) in bubble_pixels(x, y, size):
            if 0 <= px < CAN and 0 <= py < CAN:
                pixels[px, py] = WHITE if kind else colour


def dot(canvas, x, y, size=5, colour=LIGHT):
    """A chunky dot with a highlight — readable even at the default pet size."""
    pixels = canvas.load()
    for dx in range(size):
        for dy in range(size):
            if 0 <= x + dx < CAN and 0 <= y + dy < CAN:
                pixels[x + dx, y + dy] = colour
    if 0 <= x < CAN and 0 <= y < CAN:
        pixels[x, y] = WHITE


def ring(canvas, radius, colour, centre=(60, 58), step=2):
    """A dotted ring of sparks — how a 1-bit alpha GIF shows a burst."""
    pixels = canvas.load()
    count = max(12, int(2 * math.pi * radius))
    for i in range(count):
        if i % step:
            continue
        angle = 2 * math.pi * i / count
        x = int(round(centre[0] + radius * math.cos(angle)))
        y = int(round(centre[1] + radius * math.sin(angle)))
        if 0 <= x < CAN and 0 <= y < CAN:
            pixels[x, y] = colour


def dust(canvas, progress, centre=(60, 84)):
    """A few specks kicked up on landing."""
    pixels = canvas.load()
    for i, (vx, vy) in enumerate(((-2.4, -1.1), (-1.2, -1.9), (0.2, -2.2),
                                  (1.4, -1.8), (2.5, -1.0))):
        age = progress * 6.0
        x = int(round(centre[0] + vx * age * 2.2))
        y = int(round(centre[1] + vy * age + 0.35 * age * age))
        if 0 <= x < CAN and 0 <= y < CAN:
            pixels[x, y] = C_PALE if i % 2 else WHITE


# -- encoding ---------------------------------------------------------------
def save(frames, name, duration, preview=None):
    """Encode frames into a GIF with one exact palette shared by the whole set."""
    path = os.path.join(ASSETS, name)
    rgba = [f.resize((CAN * SCALE, CAN * SCALE), Image.NEAREST) for f in frames]

    keys, flat = set(), []
    for frame in rgba:
        background = Image.new("RGB", frame.size, MAGENTA)
        background.paste(frame, (0, 0), frame)
        array = np.array(background)
        flat.append(array)
        keys.update(np.unique((array[..., 0].astype(np.uint32) << 16) |
                              (array[..., 1].astype(np.uint32) << 8) |
                              array[..., 2]).tolist())

    colours = [MAGENTA] + [(k >> 16 & 255, k >> 8 & 255, k & 255)
                           for k in sorted(keys) if k != (255 << 16 | 255)]
    palette = []
    for i in range(256):
        r, g, b = colours[i] if i < len(colours) else (0, 0, 0)
        palette += [r, g, b]

    lookup = np.zeros(1 << 24, dtype=np.uint8)
    for i, (r, g, b) in enumerate(colours):
        lookup[(r << 16) | (g << 8) | b] = i

    encoded = []
    for array in flat:
        packed = ((array[..., 0].astype(np.uint32) << 16) |
                  (array[..., 1].astype(np.uint32) << 8) | array[..., 2])
        image = Image.fromarray(lookup[packed], "P")
        image.putpalette(palette)
        encoded.append(image)

    encoded[0].save(path, save_all=True, append_images=encoded[1:], duration=duration,
                    loop=0, transparency=0, disposal=2, optimize=False)
    print("saved %-14s %2d frames  %6d ms  %6d bytes  %2d colours"
          % (name, len(encoded), duration * len(frames), os.path.getsize(path), len(colours)))

    if preview:
        sheet = Image.new("RGB", (len(preview) * 120, 120), (18, 26, 54))
        for i, index in enumerate(preview):
            cell = Image.new("RGB", (CAN, CAN), (18, 26, 54))
            cell.paste(frames[index], (0, 0), frames[index])
            sheet.paste(cell.resize((120, 120), Image.NEAREST), (i * 120, 0))
        sheet.save(os.path.join(HERE, f"preview-{name.replace('.gif', '')}.png"))


def save_mark(name, pixels):
    """A tiny overlay glyph (a waiting mark), drawn 1:1 and upscaled by CSS.

    The size comes from the glyph itself, so a taller mark is never clipped.
    """
    width = max(x for x, _, _ in pixels) + 1
    height = max(y for _, y, _ in pixels) + 1
    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    for (x, y, colour) in pixels:
        draw.point((x, y), fill=colour)
    image.resize((width * SCALE, height * SCALE), Image.NEAREST).save(
        os.path.join(ASSETS, name))
    print("saved %-18s %dx%d" % (name, width * SCALE, height * SCALE))
