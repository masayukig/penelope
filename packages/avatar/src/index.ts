// How an avatar is read (ADR-0036): the backend reads the avatar in
// /memory/avatar/ with this, and `avatar check` in the sandbox tells the
// agent what in it is wrong with the same code. A face that breaks a rule is
// left out and named among the problems; nothing here throws on what the
// avatar holds.
//
// avatar.json lists what the avatar has. Fields it does not know are left as
// they are, so that kinds of files can be added later.
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";

/** The file that lists what the avatar has. */
export const AVATAR_FILE = "avatar.json";

/** The largest image a face may be. The backend reads it whole for each request. */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** The image types a face may be, by its extension. */
export const ICON_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

/** The first bytes of each type, to see that a file is what its extension says. */
const LOOKS: Readonly<Record<string, (body: Buffer) => boolean>> = {
  "image/png": (body) => body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/jpeg": (body) => body.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  "image/gif": (body) => body.subarray(0, 4).toString("latin1") === "GIF8",
  "image/webp": (body) => body.subarray(0, 4).toString("latin1") === "RIFF" && body.subarray(8, 12).toString("latin1") === "WEBP",
  "image/svg+xml": (body) => body.toString("utf8").includes("<svg"),
};

/**
 * What the avatar gives: her default name, and the image of each face by
 * expression and the PNG of the faces that have one, each relative to the
 * avatar's directory.
 */
export type Avatar = {
  name: string | undefined;
  icons: Record<string, string>;
  pngIcons: Record<string, string>;
};

export type Reading = { avatar: Avatar; problems: string[] };

/** A file of the avatar that may not be read: outside it, not a plain file, or too large. */
export class Refused extends Error {}

/** Reads the avatar in `dir`: what may be used of it, and what is wrong in it. */
export function readAvatar(dir: string): Reading {
  const problems: string[] = [];
  const avatar: Avatar = { name: undefined, icons: {}, pngIcons: {} };
  let text: string;
  try {
    text = readInside(dir, AVATAR_FILE).toString("utf8");
  } catch (error) {
    problems.push(`${AVATAR_FILE}: ${reason(error)}`);
    return { avatar, problems };
  }
  let list: unknown;
  try {
    list = JSON.parse(text);
  } catch (error) {
    problems.push(`${AVATAR_FILE}: not JSON: ${reason(error)}`);
    return { avatar, problems };
  }
  if (!isObject(list)) {
    problems.push(`${AVATAR_FILE}: not a JSON object`);
    return { avatar, problems };
  }

  if (typeof list.name === "string" && list.name.trim() !== "") avatar.name = list.name.trim();
  else if (list.name !== undefined) problems.push(`${AVATAR_FILE}: name must be a string that is not empty`);

  const faces = (field: "icons" | "pngIcons", fits: (type: string | undefined) => boolean, what: string) => {
    const value = list[field];
    if (value === undefined) return;
    if (!isObject(value)) {
      problems.push(`${AVATAR_FILE}: ${field} must be an object of expression to file`);
      return;
    }
    for (const [expression, file] of Object.entries(value)) {
      const where = `${field}.${expression}`;
      if (typeof file !== "string" || file === "") {
        problems.push(`${where}: must be the path of a file, relative to the avatar`);
        continue;
      }
      const type = ICON_TYPES[path.extname(file).toLowerCase()];
      if (!fits(type)) {
        problems.push(`${where}: ${file} must be ${what}`);
        continue;
      }
      let body: Buffer;
      try {
        body = readInside(dir, file);
      } catch (error) {
        problems.push(`${where}: ${file}: ${reason(error)}`);
        continue;
      }
      if (!LOOKS[type!]!(body)) {
        problems.push(`${where}: ${file} is not ${type} inside, as its extension says`);
        continue;
      }
      avatar[field][expression] = file;
    }
  };
  faces("icons", (type) => type !== undefined, `an image (${Object.keys(ICON_TYPES).join(", ")})`);
  faces("pngIcons", (type) => type === "image/png", "a PNG (.png)");
  return { avatar, problems };
}

/**
 * The bytes of `file`, relative to the avatar's directory `dir`, when it is a
 * plain file inside it once every link is followed. The directory itself is
 * not a link. Where the opened file really is comes from /proc, so that a
 * link put in its place after the check is not followed.
 */
export function readInside(dir: string, file: string): Buffer {
  const root = path.resolve(dir);
  let top;
  try {
    top = lstatSync(root);
  } catch {
    throw new Refused(`the avatar's directory ${root} is not there`);
  }
  if (top.isSymbolicLink() || !top.isDirectory()) throw new Refused(`the avatar's directory ${root} must be a directory, not a link`);
  const real = path.join(realpathSync(path.dirname(root)), path.basename(root));
  const wanted = path.resolve(root, file);
  if (!wanted.startsWith(`${root}${path.sep}`)) throw new Refused("outside the avatar's directory");

  let fd: number;
  try {
    fd = openSync(wanted, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    throw new Refused((error as NodeJS.ErrnoException).code === "ENOENT" ? "not there" : reason(error));
  }
  try {
    const opened = existsSync(`/proc/self/fd/${fd}`) ? readlinkSync(`/proc/self/fd/${fd}`) : realpathSync(wanted);
    if (!opened.startsWith(`${real}${path.sep}`)) throw new Refused("a link to outside the avatar's directory");
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Refused("not a plain file");
    if (stat.size > MAX_IMAGE_BYTES) throw new Refused(`larger than ${MAX_IMAGE_BYTES} bytes`);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
