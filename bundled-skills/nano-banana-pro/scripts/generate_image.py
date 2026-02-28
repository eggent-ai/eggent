#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "httpx>=0.27.0",
#     "pillow>=10.0.0",
# ]
# ///
"""
Generate images using Gemini 3.1 Flash Image via OpenRouter API (Nano Banana Pro).

Usage:
    uv run generate_image.py --prompt "your image description" --filename "output.png" [--resolution 1K|2K|4K] [--api-key KEY]

Multi-image editing (up to 14 images):
    uv run generate_image.py --prompt "combine these images" --filename "output.png" -i img1.png -i img2.png -i img3.png
"""

import argparse
import base64
import json
import os
import sys
from io import BytesIO
from pathlib import Path

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_MODEL = "google/gemini-3.1-flash-image-preview"


def get_api_key(provided_key: str | None) -> str | None:
    """Get API key from argument first, then environment."""
    if provided_key:
        return provided_key
    return os.environ.get("OPENROUTER_API_KEY")


def image_to_base64_url(img_path: str) -> tuple[str, tuple[int, int]]:
    """Convert image file to base64 data URL, return (data_url, (width, height))."""
    from PIL import Image as PILImage

    img = PILImage.open(img_path)
    size = img.size
    buf = BytesIO()
    img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode()
    return f"data:image/png;base64,{b64}", size


def save_image(image_bytes: bytes, output_path: Path):
    """Decode image bytes and save as PNG."""
    from PIL import Image as PILImage

    image = PILImage.open(BytesIO(image_bytes))
    if image.mode == 'RGBA':
        rgb_image = PILImage.new('RGB', image.size, (255, 255, 255))
        rgb_image.paste(image, mask=image.split()[3])
        rgb_image.save(str(output_path), 'PNG')
    elif image.mode == 'RGB':
        image.save(str(output_path), 'PNG')
    else:
        image.convert('RGB').save(str(output_path), 'PNG')


def main():
    parser = argparse.ArgumentParser(
        description="Generate images using Nano Banana Pro (Gemini 3.1 Flash Image via OpenRouter)"
    )
    parser.add_argument(
        "--prompt", "-p",
        required=True,
        help="Image description/prompt"
    )
    parser.add_argument(
        "--filename", "-f",
        required=True,
        help="Output filename (e.g., sunset-mountains.png)"
    )
    parser.add_argument(
        "--input-image", "-i",
        action="append",
        dest="input_images",
        metavar="IMAGE",
        help="Input image path(s) for editing/composition. Can be specified multiple times (up to 14 images)."
    )
    parser.add_argument(
        "--resolution", "-r",
        choices=["0.5K", "1K", "2K", "4K"],
        default="1K",
        help="Output resolution: 0.5K, 1K (default), 2K, or 4K"
    )
    parser.add_argument(
        "--api-key", "-k",
        help="OpenRouter API key (overrides OPENROUTER_API_KEY env var)"
    )
    parser.add_argument(
        "--model", "-m",
        default=DEFAULT_MODEL,
        help=f"OpenRouter model ID (default: {DEFAULT_MODEL})"
    )

    args = parser.parse_args()

    # Get API key
    api_key = get_api_key(args.api_key)
    if not api_key:
        print("Error: No API key provided.", file=sys.stderr)
        print("Please either:", file=sys.stderr)
        print("  1. Provide --api-key argument", file=sys.stderr)
        print("  2. Set OPENROUTER_API_KEY environment variable", file=sys.stderr)
        sys.exit(1)

    # Import here after checking API key to avoid slow import on error
    import httpx

    # Set up output path
    output_path = Path(args.filename)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # Build message content
    output_resolution = args.resolution
    content_parts = []

    # Load input images if provided (up to 14 supported)
    if args.input_images:
        if len(args.input_images) > 14:
            print(f"Error: Too many input images ({len(args.input_images)}). Maximum is 14.", file=sys.stderr)
            sys.exit(1)

        max_input_dim = 0
        for img_path in args.input_images:
            try:
                data_url, (width, height) = image_to_base64_url(img_path)
                content_parts.append({
                    "type": "image_url",
                    "image_url": {"url": data_url}
                })
                print(f"Loaded input image: {img_path}")
                max_input_dim = max(max_input_dim, width, height)
            except Exception as e:
                print(f"Error loading input image '{img_path}': {e}", file=sys.stderr)
                sys.exit(1)

        # Auto-detect resolution from largest input if not explicitly set
        if args.resolution == "1K" and max_input_dim > 0:
            if max_input_dim >= 3000:
                output_resolution = "4K"
            elif max_input_dim >= 1500:
                output_resolution = "2K"
            else:
                output_resolution = "1K"
            print(f"Auto-detected resolution: {output_resolution} (from max input dimension {max_input_dim})")

    # Add text prompt
    content_parts.append({"type": "text", "text": args.prompt})

    # Build request payload per OpenRouter image generation API:
    # - modalities: ["image", "text"] (image first)
    # - image_config.image_size for resolution control
    payload = {
        "model": args.model,
        "messages": [
            {"role": "user", "content": content_parts}
        ],
        "modalities": ["image", "text"],
        "image_config": {
            "image_size": output_resolution,
        },
        "stream": False,
    }

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://eggent.app",
        "X-Title": "Eggent Nano Banana Pro",
    }

    img_count = len(args.input_images) if args.input_images else 0
    if args.input_images:
        print(f"Processing {img_count} image{'s' if img_count > 1 else ''} at {output_resolution} via OpenRouter ({args.model})...")
    else:
        print(f"Generating image at {output_resolution} via OpenRouter ({args.model})...")

    try:
        resp = httpx.post(
            OPENROUTER_URL,
            headers=headers,
            json=payload,
            timeout=120.0,
        )
        resp.raise_for_status()
        data = resp.json()
    except httpx.HTTPStatusError as e:
        print(f"API error {e.response.status_code}: {e.response.text}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Request error: {e}", file=sys.stderr)
        sys.exit(1)

    # Parse response
    image_saved = False
    choices = data.get("choices", [])
    if not choices:
        print("Error: Empty response from API.", file=sys.stderr)
        print(f"Response: {json.dumps(data, indent=2)}", file=sys.stderr)
        sys.exit(1)

    message = choices[0].get("message", {})

    # Print text content if present
    content = message.get("content", "")
    if isinstance(content, str) and content:
        print(f"Model response: {content}")
    elif isinstance(content, list):
        for part in content:
            if isinstance(part, dict) and part.get("type") == "text":
                text = part.get("text", "")
                if text:
                    print(f"Model response: {text}")

    # Images are returned in message.images[] as base64 data URLs
    images = message.get("images", [])
    for img_part in images:
        if not isinstance(img_part, dict):
            continue
        image_url = img_part.get("image_url", {}).get("url", "")
        if image_url.startswith("data:"):
            _header, b64_data = image_url.split(",", 1)
            image_bytes = base64.b64decode(b64_data)
            save_image(image_bytes, output_path)
            image_saved = True
            break

    # Fallback: some responses may put images inside content array
    if not image_saved and isinstance(content, list):
        for part in content:
            if not isinstance(part, dict):
                continue
            if part.get("type") == "image_url":
                image_url = part.get("image_url", {}).get("url", "")
                if image_url.startswith("data:"):
                    _header, b64_data = image_url.split(",", 1)
                    image_bytes = base64.b64decode(b64_data)
                    save_image(image_bytes, output_path)
                    image_saved = True
                    break

    if image_saved:
        full_path = output_path.resolve()
        print(f"\nImage saved: {full_path}")
        # eggent parses MEDIA tokens and will attach the file on supported providers.
        print(f"MEDIA: {full_path}")
    else:
        print("Error: No image was generated in the response.", file=sys.stderr)
        print(f"Full response: {json.dumps(data, indent=2)}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
