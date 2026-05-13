#!/usr/bin/env bash
#
# Fetches RAD Game Tools' Oodle source from EpicGames/UnrealEngine (via
# WorkingRobot/OodleUE, which mirrors it daily) and lays it out under
# `c/oodle-src/` for the Makefile to compile.
#
# This source is governed by the Unreal Engine EULA (NOT an open-source
# license). The script requires explicit user confirmation before
# downloading. By proceeding, you are accepting RAD/Epic's terms.
#
# Usage:
#   bash scripts/setup-source.sh              # interactive prompt
#   bash scripts/setup-source.sh --accept-eula # skip prompt
#
# The downloaded source is gitignored — it will never be committed
# back to this repository.

set -euo pipefail

# Repo root for this package (the script's parent's parent).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC_DIR="$PKG_DIR/c/oodle-src"

EULA_URL="https://www.unrealengine.com/eula/unreal"

# Use a specific WorkingRobot mirror commit for reproducibility. Bumping
# this version means re-running setup-source.sh; the new source will
# be picked up by the next `make`.
OODLE_VERSION="${OODLE_VERSION:-2.9.16}"
# This is the path-in-tree where WorkingRobot mirrors the SDK.
SRC_TREE_PATH="Engine/Source/Runtime/OodleDataCompression/Sdks/${OODLE_VERSION}"
# We download the entire WorkingRobot repo tarball at a pinned ref and
# extract only the SDK subtree. The ref is the `main` HEAD when this
# script was authored; you can override it.
WORKING_ROBOT_REF="${WORKING_ROBOT_REF:-main}"

usage()
{
	cat <<EOF
Usage: $(basename "$0") [--accept-eula]

Fetches Oodle Data SDK ${OODLE_VERSION} into c/oodle-src/ for the
Makefile to consume.

By running this script you accept the Unreal Engine EULA:

    ${EULA_URL}

Options:
  --accept-eula   Skip the interactive confirmation prompt. Use this
                  in CI / automated builds where you've reviewed the
                  EULA out-of-band.

Environment:
  OODLE_VERSION         override the version to fetch (default ${OODLE_VERSION})
  WORKING_ROBOT_REF     override the git ref of WorkingRobot/OodleUE
                        (default ${WORKING_ROBOT_REF})
EOF
}

ACCEPTED=0
for arg in "$@"; do
	case "$arg" in
		-h|--help)
			usage; exit 0 ;;
		--accept-eula)
			ACCEPTED=1 ;;
		*)
			echo "Unknown argument: $arg" >&2
			usage >&2
			exit 1 ;;
	esac
done

cat <<EOF

================================================================
  Oodle Data Compression — source fetch
================================================================

This script will download RAD Game Tools' Oodle Data SDK ${OODLE_VERSION}
from EpicGames/UnrealEngine (via the WorkingRobot/OodleUE mirror).

The Oodle source is governed by the Unreal Engine EULA, which is
NOT an open-source license. By proceeding you are agreeing to those
terms. Read the EULA at:

    ${EULA_URL}

The downloaded source will be placed in:

    ${SRC_DIR}

This directory is gitignored — the source will NOT be committed back
to this repository or redistributed by it. The compiled WASM artifact
this build produces is also yours; this project does not host it.

EOF

if [ "$ACCEPTED" -ne 1 ]; then
	read -rp "Do you accept the Unreal Engine EULA and want to proceed? [y/N] " reply
	case "$reply" in
		y|Y|yes|YES) ;;
		*) echo "Aborted." >&2; exit 1 ;;
	esac
fi

# Tool availability checks.
for tool in curl tar; do
	if ! command -v "$tool" >/dev/null 2>&1; then
		echo "ERROR: '$tool' is required but not found in PATH." >&2
		exit 1
	fi
done

# Fresh fetch every time. The SDK is small (~10 MB extracted); we
# don't bother with incremental updates.
echo "Fetching WorkingRobot/OodleUE@${WORKING_ROBOT_REF} ..."
TMP_TARBALL="$(mktemp -t oodle-src.XXXXXX.tar.gz)"
trap 'rm -f "$TMP_TARBALL"' EXIT
curl -fsSL \
	"https://github.com/WorkingRobot/OodleUE/archive/${WORKING_ROBOT_REF}.tar.gz" \
	-o "$TMP_TARBALL"

# Extract only the SDK subtree, stripping the top-level wrapper.
TMP_EXTRACT="$(mktemp -d -t oodle-src.XXXXXX)"
trap 'rm -rf "$TMP_TARBALL" "$TMP_EXTRACT"' EXIT
tar -xzf "$TMP_TARBALL" -C "$TMP_EXTRACT" \
	--strip-components=2 \
	"*/${SRC_TREE_PATH}/include" \
	"*/${SRC_TREE_PATH}/src" 2>/dev/null

# The tar above strips 2 leading components ("OodleUE-<ref>/Engine"),
# so the result lives at: $TMP_EXTRACT/Source/Runtime/OodleDataCompression/Sdks/2.9.16/{include,src}
# We want it flatter: $SRC_DIR/include and $SRC_DIR/src.
EXTRACTED_BASE="$TMP_EXTRACT/Source/Runtime/OodleDataCompression/Sdks/${OODLE_VERSION}"
if [ ! -d "$EXTRACTED_BASE/include" ] || [ ! -d "$EXTRACTED_BASE/src" ]; then
	echo "ERROR: extraction did not produce expected directories." >&2
	echo "Looked for: $EXTRACTED_BASE/{include,src}" >&2
	echo "Contents of TMP_EXTRACT:" >&2
	ls -la "$TMP_EXTRACT" >&2 || true
	exit 1
fi

mkdir -p "$SRC_DIR"
# Wipe any prior contents so we don't end up mixing versions.
rm -rf "$SRC_DIR/include" "$SRC_DIR/src"
mv "$EXTRACTED_BASE/include" "$SRC_DIR/include"
mv "$EXTRACTED_BASE/src" "$SRC_DIR/src"

# Drop a tiny VERSION file so we can detect mismatches later.
echo "${OODLE_VERSION}" > "$SRC_DIR/VERSION"

cat <<EOF

================================================================
  Done.
================================================================

Oodle Data SDK ${OODLE_VERSION} has been fetched into:

    ${SRC_DIR}

Next steps:

    make setup    # install wasi-sdk if you haven't already
    make          # compile to src/oodle.wasm

EOF
