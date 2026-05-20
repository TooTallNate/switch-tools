#!/usr/bin/env bash
#
# Fetches the ffmpeg source at our pinned commit + applies our
# patches. Mirrors the bink1-wasm script; we pin a slightly newer
# commit than bink1 because Paul B Mahol's bink2 patch was
# developed against ffmpeg master at that snapshot.
#
# ffmpeg is LGPL-2.1+ — the compiled `ffmpeg.wasm` produced by the
# subsequent `make` is freely redistributable.
#
# The downloaded source is gitignored and never committed back.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC_DIR="$PKG_DIR/build/ffmpeg"

# Same commit the xypwn/ffmpeg-bink2-builds CI uses. The bink2
# patch is developed against this exact tree.
FFMPEG_REPO="${FFMPEG_REPO:-https://github.com/FFmpeg/FFmpeg.git}"
FFMPEG_REF="${FFMPEG_REF:-e9107d16f3ea1eff48f0bfdcaff49f7c32a20919}"

cat <<EOF
================================================================
  @tootallnate/ffmpeg-wasm — fetch ffmpeg source
================================================================

This will git-clone ffmpeg ($FFMPEG_REPO at $FFMPEG_REF) into:
  $SRC_DIR

ffmpeg is licensed under the GNU Lesser General Public License,
v2.1 or later. The compiled WebAssembly artifact this package
produces is therefore also LGPL-2.1-or-later, which permits
redistribution alongside this package's MIT-licensed wrapper.

For details see https://www.gnu.org/licenses/lgpl-2.1.html and
the bundled LICENSE.LGPL-2.1 file in this package.

EOF

if [ -d "$SRC_DIR/.git" ]; then
    echo "ffmpeg source already present at $SRC_DIR; refreshing checkout."
    cd "$SRC_DIR"
    git fetch --depth=1 origin "$FFMPEG_REF"
    git checkout --force "$FFMPEG_REF"
else
    mkdir -p "$(dirname "$SRC_DIR")"
    git clone --filter=tree:0 "$FFMPEG_REPO" "$SRC_DIR"
    cd "$SRC_DIR"
    git checkout "$FFMPEG_REF"
fi

# The xypwn workflow also cherry-picks an assembler-fix commit
# (`effadce6c756247ea8bae32dc13bb3e6f464f0eb`) that's needed for
# the build to succeed. We don't enable assembler in our config
# (`--disable-asm`), so we skip that cherry-pick.

echo "ffmpeg source ready at $SRC_DIR"
