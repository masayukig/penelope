---
name: sd-webui
description: Stable Diffusion WebUI, for drawing with sdctl.
hosts:
  - sd-webui.example.com
---

- `SDCTL_URL` and `SDCTL_TOKEN` (a surrogate) are set.
- Others draw on the same WebUI: do not change its options (`POST /sdapi/v1/options`, `sdctl models set`).
