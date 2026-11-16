// The limits of the images a reply carries (ADR-0032, docs/sandbox-api.md,
// "返事"), shared by the runner, which reads the files, and the backend, which
// checks and keeps them.

/** At most this many images in one reply. */
export const REPLY_IMAGES_MAX = 4;

/** At most this many bytes in one image (10 MiB). */
export const REPLY_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** The kinds of image a reply carries, told from their first bytes: those the Web UI shows as they are. */
export const REPLY_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
