---
name: backend
description: Her own backend (where events come from and replies go). The runner uses it; she never calls it herself.
hosts:
  - backend.penelope.internal
---

The runner calls it with `PENELOPE_BACKEND_URL` and `PENELOPE_BACKEND_TOKEN` (a surrogate). It is inside the Pod.
