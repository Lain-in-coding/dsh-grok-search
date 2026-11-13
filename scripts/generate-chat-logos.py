"""Regenerate the small chat-only whale assets (development tool; Pillow 12).

The existing settings artwork stays unchanged. Precompose its multiply/screen
appearance against the chat node's --soft colors so the scrolling renderer
does not need a backdrop-dependent blend layer. Nothing runs at client startup.
Run only when the source artwork or the corresponding node colors change.
"""

from pathlib import Path

from PIL import Image


def generate():
    directory = Path(__file__).resolve().parent.parent / "src" / "assets" / "logos"
    with Image.open(directory / "deepseek-harness.png") as original:
        image = original.convert("RGBA").resize((64, 64), Image.Resampling.LANCZOS)
    red, green, blue, alpha = image.split()
    for theme, background in [("light", (246, 247, 249)), ("dark", (37, 40, 47))]:
        channels = []
        for channel, base in zip((red, green, blue), background):
            lut = [
                round(value * base / 255)
                if theme == "light"
                else round(255 - value * (255 - base) / 255)
                for value in range(256)
            ]
            channels.append(channel.point(lut))
        result = Image.merge("RGBA", (*channels, alpha))
        target = directory / f"deepseek-harness-chat-{theme}.png"
        result.save(target, optimize=True)
        print(f"{target.name}: 64x64, {target.stat().st_size} bytes")


if __name__ == "__main__":
    generate()
