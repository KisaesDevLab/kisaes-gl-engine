#!/bin/sh
# Copyright 2026 Kisaes LLC
# Licensed under the PolyForm Internal Use License 1.0.0.
# You may not distribute this software. See LICENSE for terms.

# Runs as root, normalizes the bind-mounted /data volume to UID/GID 1001
# (the "app" user inside the container), then drops privileges via su-exec
# and exec's whatever CMD compose set. Without this step, a host-created
# ./data dir (owned by the installer's UID, commonly 1000) is unwritable
# from inside the container and every mkdir/writeFile route module fails
# with EACCES at import time.
#
# Idempotent: chown -R on an already-correct tree is cheap, and the
# container is started fresh on every `compose up` anyway.

set -e

TARGET_UID=1001
TARGET_GID=1001

if [ -d /data ]; then
  # Only chown what doesn't already belong to the app user. Walking the
  # full tree unconditionally would churn a lot of inode metadata on a
  # large existing install (attachments, backups) and push metadata
  # writes through the bind mount on every restart.
  find /data ! -user "$TARGET_UID" -exec chown "$TARGET_UID:$TARGET_GID" {} +
  # Make sure the expected subdirs exist even if the host mount was
  # empty — otherwise first writes race against mkdir.
  for sub in uploads backups config generated cache; do
    mkdir -p "/data/$sub"
    chown "$TARGET_UID:$TARGET_GID" "/data/$sub"
  done
fi

exec su-exec app:app "$@"
