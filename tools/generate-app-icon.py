from pathlib import Path
import math

from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
RES = ROOT / "android" / "app" / "src" / "main" / "res"


def lerp(a, b, t):
    return int(a + (b - a) * t)


def gradient(size, c1=(11, 92, 173), c2=(8, 75, 143)):
    img = Image.new("RGBA", (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x * 0.58 + y * 0.42) / max(1, size - 1)
            px[x, y] = (
                lerp(c1[0], c2[0], t),
                lerp(c1[1], c2[1], t),
                lerp(c1[2], c2[2], t),
                255,
            )
    return img


def rounded_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def draw_symbol(draw, size, scale=1.0):
    s = size
    cx = s / 2
    white = (255, 255, 255, 245)
    soft = (231, 240, 251, 245)
    gold = (255, 143, 0, 255)
    shadow = (0, 24, 64, 70)

    def xy(points):
        return [(cx + (x - 54) * s / 108 * scale, cx + (y - 54) * s / 108 * scale) for x, y in points]

    # Shadow and tower body.
    draw.polygon(xy([(39, 38), (69, 38), (75, 78), (33, 78)]), fill=shadow)
    draw.polygon(xy([(37, 34), (71, 34), (76, 79), (32, 79)]), fill=white)
    draw.polygon(xy([(43, 43), (65, 43), (69, 73), (39, 73)]), fill=soft)

    # Crown blocks.
    block_w = 7 * s / 108 * scale
    block_h = 8 * s / 108 * scale
    for x in (39, 50.5, 62):
        left = cx + (x - 54) * s / 108 * scale
        top = cx + (28 - 54) * s / 108 * scale
        draw.rounded_rectangle((left, top, left + block_w, top + block_h), radius=max(1, int(s * 0.015)), fill=white)

    # Inner slit and base.
    draw.rounded_rectangle(
        (
            cx - 4 * s / 108 * scale,
            cx + 1 * s / 108 * scale,
            cx + 4 * s / 108 * scale,
            cx + 22 * s / 108 * scale,
        ),
        radius=max(1, int(s * 0.018)),
        fill=(11, 92, 173, 225),
    )
    draw.rounded_rectangle(
        (
            cx - 28 * s / 108 * scale,
            cx + 25 * s / 108 * scale,
            cx + 28 * s / 108 * scale,
            cx + 33 * s / 108 * scale,
        ),
        radius=max(1, int(s * 0.028)),
        fill=white,
    )

    # Lightning mark.
    draw.polygon(xy([(64, 31), (55, 52), (66, 52), (49, 80), (55, 58), (45, 58)]), fill=gold)


def make_legacy_icon(size, round_icon=False):
    img = gradient(size)
    draw = ImageDraw.Draw(img)
    draw.ellipse((size * 0.58, size * 0.08, size * 1.08, size * 0.58), fill=(40, 124, 205, 255))
    draw.arc((size * 0.60, size * 0.10, size * 1.04, size * 0.54), 126, 246, fill=(231, 240, 251, 145), width=max(1, size // 24))
    draw_symbol(draw, size, 0.92)
    radius = size // 2 if round_icon else int(size * 0.22)
    mask = rounded_mask(size, radius)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def make_foreground(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    draw_symbol(sd, size, 0.78)
    shadow = shadow.filter(ImageFilter.GaussianBlur(max(1, size // 64)))
    img.alpha_composite(shadow)
    draw_symbol(ImageDraw.Draw(img), size, 0.78)
    return img


def make_splash(size):
    img = gradient(size, (245, 247, 251), (231, 240, 251))
    draw = ImageDraw.Draw(img)
    badge = make_legacy_icon(int(size * 0.34), False)
    img.alpha_composite(badge, ((size - badge.width) // 2, (size - badge.height) // 2))
    return img.convert("RGB")


def main():
    densities = {
        "mipmap-mdpi": (48, 108),
        "mipmap-hdpi": (72, 162),
        "mipmap-xhdpi": (96, 216),
        "mipmap-xxhdpi": (144, 324),
        "mipmap-xxxhdpi": (192, 432),
    }
    for folder, (icon_size, foreground_size) in densities.items():
        target = RES / folder
        make_legacy_icon(icon_size, False).save(target / "ic_launcher.png")
        make_legacy_icon(icon_size, True).save(target / "ic_launcher_round.png")
        make_foreground(foreground_size).save(target / "ic_launcher_foreground.png")

    splash_sizes = {
        "drawable": 320,
        "drawable-land-mdpi": 320,
        "drawable-land-hdpi": 480,
        "drawable-land-xhdpi": 640,
        "drawable-land-xxhdpi": 960,
        "drawable-land-xxxhdpi": 1280,
        "drawable-port-mdpi": 320,
        "drawable-port-hdpi": 480,
        "drawable-port-xhdpi": 640,
        "drawable-port-xxhdpi": 960,
        "drawable-port-xxxhdpi": 1280,
    }
    for folder, size in splash_sizes.items():
        make_splash(size).save(RES / folder / "splash.png", optimize=True)


if __name__ == "__main__":
    main()
