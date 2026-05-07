/**
 * Wwise WEM (Wwise Encoded Media) — the per-asset audio container
 * shipped inside `.bnk` SoundBanks (DIDX/DATA chunk) and `.pck`
 * AKPK packages (StreamedFiles LUT).
 *
 * A WEM is a Wwise-flavoured RIFF:
 *
 *   ┌──────────────────────────────────────────┐
 *   │ "RIFF" / size / "WAVE"                   │
 *   ├──────────────────────────────────────────┤
 *   │ "fmt " — pseudo-WAVEFORMATEX             │  size 0x10..0x42
 *   │   u16 codec_id, u16 channels,            │
 *   │   u32 sample_rate, u32 avg_bps,          │
 *   │   u16 block_align, u16 bits_per_sample,  │
 *   │   u16 extra_size, ...codec extension     │
 *   ├──────────────────────────────────────────┤
 *   │ "data" / size / payload                  │
 *   ├──────────────────────────────────────────┤
 *   │ optional: "smpl" (loop), "seek" (Opus    │
 *   │ seek table for OPUSWW), "vorb" (older    │
 *   │ Vorbis), "WiiH" (NGC DSP coefs), ...     │
 *   └──────────────────────────────────────────┘
 *
 * Codec dispatch table (vgmstream's authoritative mapping):
 *
 *   0x0001  PCM 16-bit LE
 *   0x0002  IMA / DSP / PTADPCM (disambiguated by extra_size)
 *   0x0069  XBOX-IMA (older)
 *   0x0161  XWMA (WMA v2)
 *   0x0162  XWMA Pro
 *   0x0165  XMA2
 *   0x0166  XMA2 (alt)
 *   0xAAC0  AAC
 *   0xFFF0  NGC DSP-ADPCM
 *   0xFFFB  HEVAG (PSV)
 *   0xFFFC  ATRAC9
 *   0xFFFE  PCMEX (PCM for Wwise authoring)
 *   0xFFFF  Wwise Vorbis
 *   0x3039  OPUSNX (Wwise's Switch-native Opus framing)
 *   0x3040  OPUS   (standard Ogg-Opus)
 *   0x3041  OPUSWW (newer Wwise Opus, with seek table)
 *   0x8311  PTADPCM (newer ADPCM, replaces IMA in 2019.1+)
 *
 * This package fully decodes the formats we can play in a browser:
 *
 *   - **PCM 16-bit LE**     → WAV blob
 *   - **OPUSNX (Switch)**   → Ogg-Opus blob (HTML5 `<audio>` plays directly)
 *   - **OPUS (standard)**   → already Ogg-Opus, just re-emit the data chunk
 *
 * Other codecs surface a clear "not supported" error from
 * `decodeWemToBlob`. Wwise Vorbis in particular requires custom
 * codebook reconstruction (a ww2ogg-style port) which is its own
 * substantial undertaking.
 */

export {
	WEM_RIFF_MAGIC,
	type WemCodecId,
	WEM_CODEC_NAMES,
	type ParsedWem,
	type WemChunk,
	type WemFmt,
	parseWem,
	isWem,
} from './parse.js';

export {
	type WemDecodeResult,
	decodeWemToBlob,
	encodeWavBlobFromPcm16,
} from './decode.js';

export { wemSwitchOpusToOggOpus } from './opusnx.js';
