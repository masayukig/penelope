#!/bin/sh
# An init container an overlay may add (README.md, "Avatar"): fetches one
# avatar directory (avatar.json, icons/, slack/, appearance.yaml,
# sdctl-params.yaml) from a public git repository into an emptyDir, which
# the backend mounts as PENELOPE_AVATARS_DIR and copies into /memory/avatar/
# the first time (ADR-0036). Only needed for an avatar that is not in the
# images.
#
#   AVATAR_REPO    the repository's URL
#   AVATAR_BRANCH  its branch or tag
#   AVATAR_PATH    the avatar's directory in the repository
#   AVATAR_NAME    the name to put it under (the same as PENELOPE_AVATAR)
#   AVATARS_DIR    where the emptyDir is mounted
#
# Like init/skills.sh, it runs before the redirect, as a UID other than the
# sandbox's. Unlike a skill, a missing avatar stops the Pod: the backend
# does not start when it has to copy an avatar it cannot find.
set -eu

: "${AVATAR_REPO:?}" "${AVATAR_BRANCH:?}" "${AVATAR_PATH:?}" "${AVATAR_NAME:?}" "${AVATARS_DIR:?}"
work=/tmp/avatar

rm -rf "$work"
git clone --quiet --depth 1 --branch "$AVATAR_BRANCH" "$AVATAR_REPO" "$work"
if [ ! -f "$work/$AVATAR_PATH/avatar.json" ]; then
  echo "avatar: $AVATAR_PATH/avatar.json is not in $AVATAR_REPO" >&2
  exit 1
fi
rm -rf "${AVATARS_DIR:?}/$AVATAR_NAME"
cp -R "$work/$AVATAR_PATH" "$AVATARS_DIR/$AVATAR_NAME"
echo "avatar: $AVATAR_NAME ($AVATAR_REPO $(git -C "$work" rev-parse --short HEAD) $AVATAR_PATH)"
rm -rf "$work"
