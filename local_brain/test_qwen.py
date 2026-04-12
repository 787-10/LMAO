"""Milestone 2 verification — load Qwen2.5-VL-7B via MLX-VLM and
describe MARS's live camera frame.

First run downloads the model (~4 GB for 4-bit). Subsequent runs
load from the HF cache in seconds.

Usage:
    python3 local_brain/test_qwen.py [image_path]
"""

import sys
import time

from mlx_vlm import load, generate
from mlx_vlm.prompt_utils import apply_chat_template
from mlx_vlm.utils import load_config


MODEL_PATH = "mlx-community/Qwen2.5-VL-7B-Instruct-4bit"


def main():
    image_path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/mars_last_frame.jpg"
    prompt = (
        "You are MARS, a mobile robot. Describe what you see in this image "
        "in two sentences: what the scene is, and whether any obvious "
        "obstacles or people are in front of you."
    )

    print(f"loading {MODEL_PATH} ...")
    t0 = time.time()
    model, processor = load(MODEL_PATH)
    config = load_config(MODEL_PATH)
    print(f"  loaded in {time.time() - t0:.1f}s")

    print(f"prompting with image {image_path!r} ...")
    formatted = apply_chat_template(processor, config, prompt, num_images=1)

    t0 = time.time()
    result = generate(
        model,
        processor,
        formatted,
        [image_path],
        max_tokens=150,
        verbose=False,
    )
    dt = time.time() - t0

    # mlx-vlm >= 0.4 returns a GenerationResult with .text
    text = getattr(result, "text", None) or str(result)

    print()
    print("=" * 60)
    print(text.strip())
    print("=" * 60)
    print(f"generate: {dt:.2f}s")


if __name__ == "__main__":
    main()
