"""Prepare the settings-only logo from the unchanged 1024px master.

Development-only Pillow tool. 256px covers the largest 40 CSS px placement at
200% zoom and 3x density, without runtime resizing code or new client libraries.
"""

from pathlib import Path

from PIL import Image


def generate():
    directory = Path(__file__).resolve().parent.parent / "src" / "assets" / "logos"
    target = directory / "deepseek-harness-settings.png"
    with Image.open(directory / "deepseek-harness.png") as original:
        original.convert("RGBA").resize((256, 256), Image.Resampling.LANCZOS).save(target, optimize=True)
    print(f"{target.name}: 256x256, {target.stat().st_size} bytes")


if __name__ == "__main__":
    generate()
