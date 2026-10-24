# stretchdiddley — SD-1

Touch-driven granular audio stretcher. Load a sample (or your own file) and drag on the screen to bend it.

- **1 finger** — vertical = pitch (±24 st), horizontal = speed (×0.06–×4), independent of each other
- **2 fingers** — pinch = volume, twist = resonant low-pass filter
- **3 fingers** — 3rd finger vertical = drive/wavefold, horizontal = bitcrush; squash the triangle = stutter
- **4+ fingers** — chaos
- Desktop: hold **Shift** while dragging for a mirrored 2nd finger, **Alt** for 3
- `space` play/stop · `h` hold (latch values on release) · `r` reset · `1–5` samples · drag & drop files

Run locally: `npm start` → http://localhost:3000

Demo loops in `public/samples` are synthesized from scratch by `tools/gen_samples.py` (royalty-free).
