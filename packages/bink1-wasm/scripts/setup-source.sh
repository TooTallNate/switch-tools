#!/usr/bin/env bash
#
# Fetches the ffmpeg source at our pinned release tag and applies
# the small patch needed to build it against wasi-sdk's wasi-libc.
#
# ffmpeg is LGPL-2.1+ — the compiled `bink1.wasm` produced by the
# subsequent `make` may be freely redistributed. This package ships
# the pre-built `bink1.wasm` directly; this script is only needed
# when (re)building from source.
#
# The downloaded source is gitignored — it will never be committed
# back to this repository.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC_DIR="$PKG_DIR/build/ffmpeg"
PATCH_DIR="$PKG_DIR/c/patches"

# Pinned tag. Bump cautiously; the file_open.c patch may need
# refreshing if upstream reshuffles the surrounding code.
FFMPEG_REPO="${FFMPEG_REPO:-https://github.com/FFmpeg/FFmpeg.git}"
FFMPEG_REF="${FFMPEG_REF:-n6.1.1}"

cat <<EOF
================================================================
  Bink 1 video decoder — ffmpeg source fetch
================================================================

This script will clone FFmpeg at the pinned tag:

    repo: ${FFMPEG_REPO}
    ref:  ${FFMPEG_REF}

ffmpeg is LGPL-2.1+ licensed. Source is fetched into:

    ${SRC_DIR}

This directory is gitignored. The compiled \`src/bink1.wasm\`
artifact IS committed to the repository for distribution
convenience; LGPL-2.1+ permits this.

EOF

for tool in git patch; do
	if ! command -v "$tool" >/dev/null 2>&1; then
		echo "ERROR: '$tool' is required but not found in PATH." >&2
		exit 1
	fi
done

# Fresh checkout every time. We use depth=1 + a single tag fetch to
# keep this fast — ffmpeg's full history is ~500 MB; a shallow
# checkout at a tag is ~80 MB.
if [ -d "$SRC_DIR" ]; then
	echo "Removing existing $SRC_DIR ..."
	rm -rf "$SRC_DIR"
fi
mkdir -p "$(dirname "$SRC_DIR")"

echo "Cloning ${FFMPEG_REPO} @ ${FFMPEG_REF} ..."
git clone --quiet --depth=1 --branch "$FFMPEG_REF" "$FFMPEG_REPO" "$SRC_DIR"

# Apply our patches in lexical order. Each `.patch` file is a unified
# diff rooted at the ffmpeg repo root.
if [ -d "$PATCH_DIR" ]; then
	shopt -s nullglob
	patches=("$PATCH_DIR"/*.patch)
	if [ ${#patches[@]} -gt 0 ]; then
		echo "Applying ${#patches[@]} patch(es) ..."
		for p in "${patches[@]}"; do
			echo "  $(basename "$p")"
			patch --quiet -p1 -d "$SRC_DIR" < "$p"
		done
	fi
fi

cat <<EOF

================================================================
  Done.
================================================================

ffmpeg source has been fetched and patched into:

    ${SRC_DIR}

Next steps:

    make setup    # install wasi-sdk if you haven't already
    make          # configure + build ffmpeg + link bink1.wasm

EOF
