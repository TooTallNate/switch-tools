#!/usr/bin/env bash
#
# Fetches the Bink 2 video decoder source from bbit-git/cnc-ra-libs and
# applies our scalar-path fixes so it builds with wasi-sdk.
#
# `cnc-ra-libs` is GPL-3.0 licensed. The compiled WASM produced by the
# subsequent `make` is also GPL-3.0. This repository (MIT) does NOT
# redistribute either the source or the compiled artifact: both live
# outside our git index after this script runs (see .gitignore).
#
# Usage:
#   bash scripts/setup-source.sh              # interactive prompt
#   bash scripts/setup-source.sh --accept-gpl # skip prompt
#
# The downloaded source is gitignored — it will never be committed
# back to this repository.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC_DIR="$PKG_DIR/c/cnc-ra-libs"
PATCH_DIR="$PKG_DIR/c/patches"

# Pinned commit. Bump this when picking up upstream improvements; the
# patches in c/patches/ may need refreshing if they no longer apply
# cleanly. We keep this pinned (vs. tracking `main`) so a fresh
# checkout always produces a reproducible build.
CNC_REPO="${CNC_REPO:-https://github.com/bbit-git/cnc-ra-libs.git}"
CNC_REF="${CNC_REF:-c5c668b848315497f82facbc963a6f7696aa21ed}"

GPL_URL="https://www.gnu.org/licenses/gpl-3.0.html"

usage()
{
	cat <<EOF
Usage: $(basename "$0") [--accept-gpl]

Fetches bbit-git/cnc-ra-libs (the Bink 2 video decoder) into
c/cnc-ra-libs/ and applies our patches so it builds with wasi-sdk.

The upstream source is GPL-3.0 licensed. The compiled WASM that
\`make\` produces from it is therefore also GPL-3.0. This repository
is MIT; neither the source nor the artifact is committed here.

By proceeding you acknowledge the GPL-3.0 license:

    ${GPL_URL}

Options:
  --accept-gpl    Skip the interactive confirmation prompt.

Environment:
  CNC_REPO        git URL to clone (default ${CNC_REPO})
  CNC_REF         git ref to check out (default pinned commit)
EOF
}

ACCEPTED=0
for arg in "$@"; do
	case "$arg" in
		-h|--help) usage; exit 0 ;;
		--accept-gpl) ACCEPTED=1 ;;
		*) echo "Unknown argument: $arg" >&2 ; usage >&2 ; exit 1 ;;
	esac
done

cat <<EOF

================================================================
  Bink 2 video decoder — source fetch
================================================================

This script will clone bbit-git/cnc-ra-libs at the pinned commit:

    repo: ${CNC_REPO}
    ref:  ${CNC_REF}

\`cnc-ra-libs\` is a GPL-3.0 licensed C&C engine port that contains
an in-tree Bink 2 video decoder. The compiled WASM this build
produces inherits GPL-3.0 from that source.

The fetched source is placed in:

    ${SRC_DIR}

This directory and the resulting WASM artifact are gitignored —
neither will be committed back to or distributed by this repository.

EOF

if [ "$ACCEPTED" -ne 1 ]; then
	read -rp "Do you acknowledge the GPL-3.0 license and want to proceed? [y/N] " reply
	case "$reply" in
		y|Y|yes|YES) ;;
		*) echo "Aborted." >&2; exit 1 ;;
	esac
fi

for tool in git patch; do
	if ! command -v "$tool" >/dev/null 2>&1; then
		echo "ERROR: '$tool' is required but not found in PATH." >&2
		exit 1
	fi
done

# Fresh checkout every time. Repo is small (~10 MB), no incremental
# update complexity.
if [ -d "$SRC_DIR" ]; then
	echo "Removing existing $SRC_DIR ..."
	rm -rf "$SRC_DIR"
fi

echo "Cloning ${CNC_REPO} ..."
git clone --quiet --no-checkout "$CNC_REPO" "$SRC_DIR"
git -C "$SRC_DIR" checkout --quiet "$CNC_REF"

# Apply our patches in lexical order. Each `.patch` file is a unified
# diff rooted at the cnc-ra-libs repo root.
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

cnc-ra-libs has been fetched and patched into:

    ${SRC_DIR}

Next steps:

    make setup    # install wasi-sdk if you haven't already
    make          # compile to src/bink2.wasm

EOF
