"""
Generates a hacker-chat app icon:
  - Deep black background
  - Neon green terminal chat bubble
  - Matrix rain dots
  - Lock glyph inside bubble (encrypted)
  - Scanline CRT effect
"""
from PIL import Image, ImageDraw, ImageFilter, ImageFont
import math, random, os

random.seed(42)

def draw_icon(size):
    S = size
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # ── Background: dark rounded square ──────────────────────────────────
    r = S * 0.22
    bg_color = (8, 10, 8, 255)
    d.rounded_rectangle([0, 0, S, S], radius=r, fill=bg_color)

    # ── Matrix rain columns ───────────────────────────────────────────────
    chars = "01アイウエオカキクケコサシスセソタチツテトナニヌネノ"
    col_w = max(4, S // 18)
    num_cols = S // col_w
    for col in range(num_cols):
        x = col * col_w + col_w // 2
        num_dots = random.randint(2, 6)
        for _ in range(num_dots):
            y = random.randint(0, S)
            alpha = random.randint(20, 70)
            dot_size = max(1, S // 64)
            d.ellipse(
                [x - dot_size, y - dot_size, x + dot_size, y + dot_size],
                fill=(0, random.randint(80, 140), 0, alpha),
            )

    # ── Chat bubble (main shape) ──────────────────────────────────────────
    pad = S * 0.12
    bx0, by0 = pad, pad * 0.9
    bx1, by1 = S - pad, S * 0.70
    br = S * 0.10

    # glow pass
    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    for i in range(6, 0, -1):
        g_alpha = 18 - i * 2
        g_expand = i * (S // 60)
        gd.rounded_rectangle(
            [bx0 - g_expand, by0 - g_expand, bx1 + g_expand, by1 + g_expand],
            radius=br + g_expand,
            fill=(0, 255, 70, g_alpha),
        )
    img = Image.alpha_composite(img, glow)
    d = ImageDraw.Draw(img)

    # bubble fill
    d.rounded_rectangle([bx0, by0, bx1, by1], radius=br, fill=(10, 18, 10, 235))

    # bubble border
    border_w = max(2, S // 64)
    d.rounded_rectangle(
        [bx0, by0, bx1, by1],
        radius=br,
        outline=(0, 255, 70, 230),
        width=border_w,
    )

    # bubble tail (bottom-left triangle)
    tail_x = bx0 + S * 0.12
    tail_top = by1
    tail_pts = [
        (tail_x, tail_top - border_w),
        (tail_x - S * 0.07, tail_top + S * 0.10),
        (tail_x + S * 0.10, tail_top - border_w),
    ]
    d.polygon(tail_pts, fill=(10, 18, 10, 235))
    # tail border lines
    d.line([tail_pts[0], tail_pts[1]], fill=(0, 255, 70, 230), width=border_w)
    d.line([tail_pts[1], tail_pts[2]], fill=(0, 255, 70, 230), width=border_w)

    # ── Lock icon inside bubble ───────────────────────────────────────────
    cx = (bx0 + bx1) / 2
    cy = (by0 + by1) / 2 - S * 0.01

    lw  = S * 0.22   # lock body width
    lh  = S * 0.17   # lock body height
    lbr = S * 0.04   # lock body corner radius

    # shackle (arc)
    shackle_r  = lw * 0.30
    shackle_t  = max(2, S // 52)
    sx0 = cx - shackle_r
    sy0 = cy - lh * 0.5 - shackle_r * 1.55
    sx1 = cx + shackle_r
    sy1 = cy - lh * 0.5 + shackle_r * 0.15
    d.arc([sx0, sy0, sx1, sy1], start=200, end=340, fill=(0, 255, 70, 240), width=shackle_t)

    # lock body
    lx0 = cx - lw / 2
    ly0 = cy - lh * 0.25
    lx1 = cx + lw / 2
    ly1 = cy + lh * 0.75
    d.rounded_rectangle([lx0, ly0, lx1, ly1], radius=lbr, fill=(0, 180, 50, 210))
    d.rounded_rectangle(
        [lx0, ly0, lx1, ly1],
        radius=lbr,
        outline=(0, 255, 70, 255),
        width=max(1, S // 80),
    )

    # keyhole circle
    kh_r = lw * 0.13
    kh_cx, kh_cy = cx, cy + lh * 0.22
    d.ellipse(
        [kh_cx - kh_r, kh_cy - kh_r, kh_cx + kh_r, kh_cy + kh_r],
        fill=(8, 10, 8, 255),
        outline=(0, 255, 70, 200),
        width=max(1, S // 100),
    )
    # keyhole stem
    stem_w = kh_r * 0.8
    d.rectangle(
        [kh_cx - stem_w / 2, kh_cy, kh_cx + stem_w / 2, kh_cy + kh_r * 1.4],
        fill=(8, 10, 8, 255),
    )

    # ── Three "message lines" below lock ─────────────────────────────────
    line_y_start = by1 + S * 0.04
    line_color   = (0, 200, 60, 180)
    line_h       = max(2, S // 80)
    for i, (llen, lx_off) in enumerate([(0.50, 0.14), (0.38, 0.14), (0.26, 0.14)]):
        lx = pad + S * lx_off
        ly = line_y_start + i * (line_h + S * 0.025)
        d.rectangle([lx, ly, lx + S * llen, ly + line_h], fill=line_color)

    # ── Scanline overlay (CRT feel) ───────────────────────────────────────
    scanlines = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    sd = ImageDraw.Draw(scanlines)
    step = max(2, S // 96)
    for y in range(0, S, step * 2):
        sd.rectangle([0, y, S, y + step - 1], fill=(0, 0, 0, 22))
    img = Image.alpha_composite(img, scanlines)

    return img


# Android icon sizes: folder → px
SIZES = {
    "mipmap-mdpi":    48,
    "mipmap-hdpi":    72,
    "mipmap-xhdpi":   96,
    "mipmap-xxhdpi":  144,
    "mipmap-xxxhdpi": 192,
}

res_dir = "android/app/src/main/res"

for folder, px in SIZES.items():
    out_dir = os.path.join(res_dir, folder)
    os.makedirs(out_dir, exist_ok=True)

    icon = draw_icon(px)
    icon.save(os.path.join(out_dir, "ic_launcher.png"))

    # Round icon variant (circle mask)
    circle_img = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    mask = Image.new("L", (px, px), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, px, px], fill=255)
    base = draw_icon(px)
    circle_img.paste(base, mask=mask)
    circle_img.save(os.path.join(out_dir, "ic_launcher_round.png"))

    print(f"  {folder}: {px}x{px} ✓")

print("\nIcons generated.")
