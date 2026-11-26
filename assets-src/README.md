# Source assets

Not deployed. Keep original high-resolution artwork here; runtime files are
generated into `public/`.

- `varun-avatar-source.png` (512x512) generates:
  - `public/assets/varun-avatar.webp` (104x104, display size 52x52 @2x)
  - `public/assets/varun-avatar-512.jpg` (organization logo in JSON-LD)
  - the portrait on `public/og-image.jpg`

Regenerate with:

```
magick assets-src/varun-avatar-source.png -resize 104x104 -quality 86 public/assets/varun-avatar.webp
magick assets-src/varun-avatar-source.png -strip -resize 512x512 -quality 88 -sampling-factor 4:2:0 public/assets/varun-avatar-512.jpg
```
