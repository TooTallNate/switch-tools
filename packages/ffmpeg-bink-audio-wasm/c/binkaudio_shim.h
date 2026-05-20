/*
 * Build-time shim for the bink-audio extension.
 *
 * FFmpeg's `binkaudio.c` is gated on `CONFIG_BINKAUDIO_RDFT_DECODER`
 * and `CONFIG_BINKAUDIO_DCT_DECODER` — flags FFmpeg's configure
 * normally sets when those codecs are explicitly enabled. Our base
 * build disables every codec, so `config_components.h` has them as
 * 0, which DCEs the entire decode path.
 *
 * Force them to 1 here, BEFORE the FFmpeg headers pull in
 * config_components.h. The `-include` flag in the Makefile makes
 * this header land first.
 */
#ifndef TTN_BINKAUDIO_SHIM_H
#define TTN_BINKAUDIO_SHIM_H

#define CONFIG_BINKAUDIO_RDFT_DECODER 1
#define CONFIG_BINKAUDIO_DCT_DECODER  1

#endif
