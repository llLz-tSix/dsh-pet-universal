"""Find the pet on a screenshot and report how much changed after hovering.

Split out of the PowerShell driver so no Python has to survive PowerShell's
quoting rules.

An optional region (x0 y0 x1 y1, physical pixels) confines the search. That
matters: the whale's blue also occurs in ordinary windows, so a whole-screen scan
happily finds some other application's blue and the driver then clicks there —
which looks exactly like a pet that ignores the mouse.
"""
import os
import sys

from PIL import Image, ImageChops
import numpy as np

BASE = os.path.dirname(os.path.abspath(__file__))
WHALE_BLUE = (77, 107, 254)


def sprite_box(path, region=None):
    image = Image.open(path).convert("RGB")
    if region is not None:
        image = image.crop(region)
    a = np.array(image).astype(int)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    mask = (b == WHALE_BLUE[2]) & (r == WHALE_BLUE[0]) & (g == WHALE_BLUE[1])
    ys, xs = np.where(mask)
    if len(xs) < 50:
        return None
    left = region[0] if region else 0
    top = region[1] if region else 0
    return (int(xs.min()) + left, int(ys.min()) + top,
            int(xs.max()) + left, int(ys.max()) + top)


def main():
    args = [int(value) for value in sys.argv[1:5]] if len(sys.argv) >= 5 else None
    region = (args[0], args[1], args[2], args[3]) if args else None

    before = os.path.join(BASE, "_h1.png")
    after = os.path.join(BASE, "_h2.png")
    box = sprite_box(before, region)
    if box is None:
        print("NONE")
        return

    x0, y0, x1, y1 = box
    print("BOX %d %d %d %d" % box)

    try:
        diff = np.array(ImageChops.difference(
            Image.open(before).convert("RGB"),
            Image.open(after).convert("RGB"),
        )).sum(axis=2)
        print("CHANGED %d" % int((diff > 30).sum()))
    except FileNotFoundError:
        print("CHANGED n/a")

    pad = 50
    crop = (max(0, x0 - pad), max(0, y0 - pad), x1 + pad, y1 + pad)
    for name, path in (("h1", before), ("h2", after)):
        try:
            image = Image.open(path).convert("RGB").crop(crop)
            image.resize((image.width * 2, image.height * 2), Image.NEAREST).save(
                os.path.join(BASE, f"_crop_{name}.png"))
        except FileNotFoundError:
            pass


if __name__ == "__main__":
    main()
