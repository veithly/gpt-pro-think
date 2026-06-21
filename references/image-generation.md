# Image Generation Workflow

Use this reference when generating images through ChatGPT's web UI with `search.js image` / `--image`.

## Model choice

ChatGPT web image generation should be sent through Pro Extended first. The script defaults image runs to `--model extended` and falls back to `Instant` only when Pro Extended is unavailable.

```bash
node search.js image --model extended --until-complete "Create one square app icon..." --image-dir ./assets/generated
node search.js image --model extended --until-complete --image-count 4 "Create exactly four distinct app icon concepts as separate images..." --image-dir ./assets/generated
```

`image` defaults to `--model extended`. `--model think` is still normalized to `thinking`, but explicit `thinking` / `instant` image runs are treated as fallback-style runs and are limited to one image.

## Multiple images

Pro Extended can produce multiple separate generated images in one response. To generate multiple images, use `--image-count N` and write the same count into the prompt; the script first verifies Pro Extended, sends one prompt, then waits for and saves up to 10 images from that response.

```bash
node search.js image --until-complete --image-count 5 "Create exactly five distinct square app icon concepts as separate images..." --image-dir ./assets/generated
```

With Pro Extended available, the total image cap is 10 per prompt. If Pro Extended is unavailable, the script falls back to Instant and limits the run to 1 image. `--image-concurrency` is a legacy no-op for the current Extended flow.

## Saving

The extractor saves large generated images from the latest assistant result and writes a manifest:

```bash
node search.js -s design-thread latest --image --until-complete --image-dir ./assets/generated
node search.js -s design-thread extract-images --resume --image-dir ./assets/generated
```

It recognizes both normal assistant messages and current ChatGPT image containers (`group/imagegen-image`). Duplicate render layers of the same `src` are ignored.

## Transparent illustrations

Do not rely on the web UI to produce real alpha transparency. Ask for the subject on a high-contrast solid background, then remove that background locally.

Prompt pattern:

```text
Create one square PNG-style illustration of <subject>.
Use a pure #00ff00 solid background.
No shadow, no reflection, no glow, no text, no watermark.
Keep the subject fully inside the frame with clear margin and do not use green in the subject.
```

Good background colors:

- `#00ff00` pure green
- `#ff00ff` magenta
- `#00ffff` cyan

Avoid colors that also appear in the subject. For example, do not use green background for plants or blue/cyan background for blue glass.

Local cutout:

```bash
node scripts/transparent-cutout.js ./assets/generated/icon-on-green.png ./assets/generated/icon-transparent.png --bg 0,255,0 --threshold 42 --padding 24
```

The script:

- samples or accepts a known background color
- flood-fills only background pixels connected to the image edge
- sets those pixels transparent
- crops to the remaining non-transparent bounds with padding
- writes an RGBA PNG

Useful options:

```bash
# Let the script infer the background from corners
node scripts/transparent-cutout.js input.png output.png

# More aggressive removal for compression artifacts / slight gradients
node scripts/transparent-cutout.js input.png output.png --bg 255,0,255 --threshold 55

# Keep original canvas size
node scripts/transparent-cutout.js input.png output.png --bg 0,255,0 --no-crop
```

If background remains, increase `--threshold` gradually. If subject edges become transparent, lower it or regenerate with a flatter, higher-contrast background.
