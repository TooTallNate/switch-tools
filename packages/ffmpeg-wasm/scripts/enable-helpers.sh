#!/usr/bin/env bash
#
# Force-enable the "common DSP helpers" in FFmpeg's configure
# output so they get compiled into libavcodec.a. These are the
# universal building blocks every video codec calls — VLC tables,
# BlockDSP, IDCT, half-pixel motion comp, etc. — analogous to
# the C runtime: NOT codecs, just shared infrastructure.
#
# FFmpeg's configure auto-enables them ONLY when a specific
# codec selects them. With our base build disabling every
# codec, none of these end up enabled by default. Rather than
# fake-enabling a codec just to drag in the helpers, we flip
# the config.h symbols directly here.
#
# Each helper has two control points:
#
#   1. `#define CONFIG_<NAME> 0` in config.h    →  flip to 1
#   2. `!CONFIG_<NAME>=yes` line in config_components.h (or
#      similar)                                 →  not actually
#                                                  required for
#                                                  the .o to be
#                                                  built; the
#                                                  Makefile keys
#                                                  off config.mak
#                                                  which the
#                                                  next `make`
#                                                  regenerates
#
# We also patch `ffbuild/config.mak` to set the CONFIG_*=yes
# flags so the Makefile's `OBJS-$(CONFIG_X)` rules pick them up.

set -euo pipefail

FFMPEG_SRC="${1:?usage: enable-helpers.sh <ffmpeg-src-dir>}"
cd "$FFMPEG_SRC"

# The dpkg-style "always include in base" set. Add to this list
# when a future extension can't find a helper symbol — that's
# usually a sign the helper should live in the base, not be
# duplicated per-extension.
HELPERS=(
    blockdsp
    pixblockdsp
    bswapdsp
    idctdsp
    fdctdsp
    hpeldsp
    qpeldsp
    videodsp
    h264chroma
    h264dsp
    h264pred
    h264qpel
    fft
    rdft
    mdct
    dct
    sinewin
    audiodsp
    mpegaudiodsp
    mpegaudio
    mpegaudioheader
    aandcttables
    wma_freqs
    cabac
    huffyuvdsp
    huffyuvencdsp
    intrax8
    me_cmp
    mpegvideo
    mpegvideoenc
    mpegvideodec
    mpeg_er
    error_resilience
    rangecoder
    vp3dsp
    pixelutils
    audio_frame_queue
    iso_media
)

# config.h: flip `#define CONFIG_X 0` → `1`
for h in "${HELPERS[@]}"; do
    upper=$(echo "$h" | tr '[:lower:]' '[:upper:]')
    sed -i.bak "s/^#define CONFIG_${upper} 0$/#define CONFIG_${upper} 1/" config.h
done

# config_components.h: same thing.
if [ -f config_components.h ]; then
    for h in "${HELPERS[@]}"; do
        upper=$(echo "$h" | tr '[:lower:]' '[:upper:]')
        sed -i.bak "s/^#define CONFIG_${upper} 0$/#define CONFIG_${upper} 1/" config_components.h
    done
fi

# Force-enable specific codec CONFIG_*_DECODER flags. The C source
# of certain codecs (e.g. binkaudio.c) has explicit
# `if (CONFIG_BINKAUDIO_DCT_DECODER && ...)` checks that the C
# compiler DCEs to nothing when the flag is 0. We enable them
# here so the decoder code is actually emitted. The base WASM
# still ships no codec_list[] entries — extensions plug in
# FFCodec pointers directly via ffmpeg_register_codec().
CODEC_FLAGS=(
    BINKAUDIO_DCT_DECODER
    BINKAUDIO_RDFT_DECODER
)
if [ -f config_components.h ]; then
    for f in "${CODEC_FLAGS[@]}"; do
        sed -i.bak "s/^#define CONFIG_${f} 0$/#define CONFIG_${f} 1/" config_components.h
    done
fi

# ffbuild/config.mak: append CONFIG_X=yes for the Makefile.
# These take the form `!CONFIG_X=yes` (the leading `!` means
# "this lookup is allowed to be absent"). The Makefile expands
# `OBJS-$(CONFIG_BLOCKDSP)` which becomes the .o when set.
{
    for h in "${HELPERS[@]}"; do
        upper=$(echo "$h" | tr '[:lower:]' '[:upper:]')
        echo "CONFIG_${upper}=yes"
        echo "!CONFIG_${upper}=yes"
    done
} >> ffbuild/config.mak

# Clean up sed backup turds.
rm -f config.h.bak config_components.h.bak

echo "Enabled ${#HELPERS[@]} DSP helpers."
