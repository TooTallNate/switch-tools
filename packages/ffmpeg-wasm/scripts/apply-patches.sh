#!/usr/bin/env bash
#
# Apply our codec_list mutability patch to a freshly-configured
# ffmpeg tree. Called from the Makefile after `./configure`.
#
# The patch must be applied AFTER configure because configure
# regenerates `libavcodec/codec_list.c` and `libavformat/demuxer_list.c`
# from scratch based on the enabled codec / demuxer flags. Our
# patches modify `allcodecs.c` / `allformats.c` (the consumers of
# those lists), not the generated lists themselves.

set -euo pipefail

FFMPEG_SRC_RAW="${1:?usage: apply-patches.sh <ffmpeg-src-dir>}"
FFMPEG_SRC="$(cd "$FFMPEG_SRC_RAW" && pwd)"
PATCH_DIR="$(cd "$(dirname "$0")/../c/patches" && pwd)"

SENTINEL="$FFMPEG_SRC/.tootallnate-patched"

if [ -f "$SENTINEL" ]; then
    echo "ffmpeg already patched; skipping."
    exit 0
fi

cd "$FFMPEG_SRC"

shopt -s nullglob
patches=("$PATCH_DIR"/*.patch)
if [ ${#patches[@]} -eq 0 ]; then
    echo "No patches to apply."
else
    for patch in "${patches[@]}"; do
        echo "Applying $(basename "$patch")"
        patch -p1 < "$patch"
    done
fi

touch "$SENTINEL"
echo "Patches step complete."
