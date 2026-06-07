# Image Generation Workflow

Use this reference when generating images through ChatGPT's web UI with `search.js image` / `--image`.

## Model choice

ChatGPT web image generation should be sent from `Instant` or `Thinking`, not Extended Pro.

```bash
node search.js image --model instant --until-complete "Create one square app icon..." --image-dir ./assets/generated
node search.js image --model think --until-complete "Create a detailed isometric icon..." --image-dir ./assets/generated
```

`image` defaults to `--model instant`. `--model think` is normalized to `thinking`.

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
