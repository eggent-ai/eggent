---
name: nano-banana-pro
description: Generate or edit images via Gemini 3.1 Flash Image through OpenRouter (Nano Banana Pro).
homepage: https://openrouter.ai/
metadata:
  {
    "eggent":
      {
        "emoji": "🍌",
        "requires": { "bins": ["uv"], "env": ["OPENROUTER_API_KEY"] },
        "primaryEnv": "OPENROUTER_API_KEY",
        "install":
          [
            {
              "id": "uv-brew",
              "kind": "brew",
              "formula": "uv",
              "bins": ["uv"],
              "label": "Install uv (brew)",
            },
          ],
      },
  }
---

# Nano Banana Pro (Gemini 3.1 Flash Image via OpenRouter)

Use the bundled script to generate or edit images. Requests are routed through the shared OpenRouter API key instead of a direct Google Gemini key.

Generate

```bash
uv run {baseDir}/scripts/generate_image.py --prompt "your image description" --filename "output.png" --resolution 1K
```

Edit (single image)

```bash
uv run {baseDir}/scripts/generate_image.py --prompt "edit instructions" --filename "output.png" -i "/path/in.png" --resolution 2K
```

Multi-image composition (up to 14 images)

```bash
uv run {baseDir}/scripts/generate_image.py --prompt "combine these into one scene" --filename "output.png" -i img1.png -i img2.png -i img3.png
```

Override model (optional)

```bash
uv run {baseDir}/scripts/generate_image.py --prompt "description" --filename "output.png" --model "google/gemini-3.1-flash-image-preview"
```

API key

- `OPENROUTER_API_KEY` env var (shared key for all OpenRouter models)
- Or set `skills."nano-banana-pro".apiKey` / `skills."nano-banana-pro".env.OPENROUTER_API_KEY` in `~/.eggent/eggent.json`

Notes

- Resolutions: `0.5K`, `1K` (default), `2K`, `4K`. (`0.5K` is exclusive to this model.)
- Use timestamps in filenames: `yyyy-mm-dd-hh-mm-ss-name.png`.
- The script prints a `MEDIA:` line for eggent to auto-attach on supported chat providers.
- Do not read the image back; report the saved path only.
- Default model: `google/gemini-3.1-flash-image-preview` (can be overridden with `--model`).
