"""
Converts a .webp (or any image) into Chrome extension icon PNGs.

Strategy for sharpness at small sizes:
  - Resize from the largest dimension down using LANCZOS (best for downscaling).
  - Add 10% padding so the icon doesn't bleed to the very edge of the canvas.
  - Composite onto a transparent background so Chrome can apply its own shape.
  - At 16×16 the source is down-sampled aggressively, so we apply a mild
    unsharp-mask pass BEFORE final resize to recover edge contrast.
"""

from PIL import Image, ImageFilter
import os

SRC  = "icon-source.png"
DEST = "icons"
SIZES = [16, 48, 128]

# Padding fraction: 10% on each side → icon occupies 80% of canvas
PAD = 0.10

def remove_white_background(img: Image.Image, tolerance: int = 240) -> Image.Image:
    """Replace near-white pixels with transparent ones."""
    img = img.convert("RGBA")
    data = img.getdata()
    new_data = []
    for r, g, b, a in data:
        if r >= tolerance and g >= tolerance and b >= tolerance:
            new_data.append((r, g, b, 0))   # fully transparent
        else:
            new_data.append((r, g, b, a))
    img.putdata(new_data)
    return img

def make_icon(src_path: str, size: int, out_path: str) -> None:
    img = Image.open(src_path).convert("RGBA")

    # ── Step 0: strip white/near-white background if present ────────────────
    # Sample the four corners; if they're all near-white the image has a
    # solid white background that needs to be made transparent.
    corners = [img.getpixel((0, 0)), img.getpixel((img.width-1, 0)),
               img.getpixel((0, img.height-1)), img.getpixel((img.width-1, img.height-1))]
    if all(r >= 230 and g >= 230 and b >= 230 for r, g, b, *_ in corners):
        img = remove_white_background(img, tolerance=240)

    # ── Step 1: crop to square (centre-crop if not already square) ──────────
    w, h = img.size
    if w != h:
        side = min(w, h)
        left = (w - side) // 2
        top  = (h - side) // 2
        img  = img.crop((left, top, left + side, top + side))

    # ── Step 2: apply mild sharpening BEFORE heavy downscale ────────────────
    # Only worth doing when final size is small; for 128 the source has
    # enough resolution that Lanczos alone is sufficient.
    if size <= 48:
        img = img.filter(ImageFilter.UnsharpMask(radius=1, percent=120, threshold=2))

    # ── Step 3: compute inner size with padding ──────────────────────────────
    inner = round(size * (1 - PAD * 2))          # e.g. 128 → 102 px
    inner = max(inner, size - 4)                 # floor: never less than 4 px border

    # ── Step 4: resize inner image with Lanczos ──────────────────────────────
    img = img.resize((inner, inner), Image.LANCZOS)

    # ── Step 5: centre-paste onto transparent canvas ─────────────────────────
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    offset = (size - inner) // 2
    canvas.paste(img, (offset, offset), img)

    # ── Step 6: save as optimised PNG ────────────────────────────────────────
    canvas.save(out_path, "PNG", optimize=True)
    print(f"  OK  {out_path}  ({size}x{size})")

if __name__ == "__main__":
    os.makedirs(DEST, exist_ok=True)

    if not os.path.exists(SRC):
        raise FileNotFoundError(f"Source not found: {SRC}")

    print(f"Source : {SRC}")
    print(f"Output : {DEST}/")
    for s in SIZES:
        make_icon(SRC, s, os.path.join(DEST, f"icon{s}.png"))

    print("\nDone. Icons written to the 'icons/' folder.")
