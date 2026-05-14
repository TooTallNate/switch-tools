/**
 * MIT-licensed C++ wrapper around bbit-git/cnc-ra-libs' Bink 2 video
 * decoder for WebAssembly.
 *
 * What this file does:
 *
 *   - Owns a single `Bink2Decoder` instance per WASM module.
 *   - Exports a small C ABI (`bink2_open`, `bink2_get_info`,
 *     `bink2_decode_frame`, `bink2_close`, plus allocation helpers)
 *     that the TS wrapper drives.
 *   - Hides the C++-only types (std::vector, std::unique_ptr) behind
 *     pointer/size pairs that JS can read from linear memory.
 *
 * What this file does NOT contain:
 *
 *   - Any of cnc-ra-libs' source. `bink2_decoder.h` and `bink2_video.h`
 *     are included from `c/cnc-ra-libs/bink2/`, which is populated by
 *     `make setup-source` and is gitignored.
 *
 * Threading: the decoder is single-threaded; the wrapper holds at
 * most one "current frame" and one "previous frame" at any time. The
 * caller (JS) is expected to call `bink2_decode_frame` in monotonic
 * frame order so the inter-frame reconstruction has the right reference.
 *
 * Memory model: the caller provides the entire .bk2 byte buffer
 * up-front via `bink2_open`. The decoder reads packets from it on
 * demand (no full materialisation of decoded video — only one
 * keyframe-sized YUV plane is held in memory at a time).
 */

#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <new>

#include "bink2_audio.h"
#include "bink2_decoder.h"
#include "bink2_video.h"
#include "bink2_background_player.h"

#define EXPORT extern "C" __attribute__((visibility("default")))

namespace {

// Per-track audio state. `decoder` carries the rolling overlap-tail
// from the previous block, so it must persist across packets.
//
// `last_packet` is filled by `bink2_audio_decode_packet`: planar
// floats per channel, plus a flat per-pair interleave (left + right
// adjacent) that JS reads with two Float32Array views. We keep
// channel-planar internally to match what the decoder produces; the
// flat buffer is built once per call.
struct Bink2AudioTrackState {
	Bink2AudioDecoder                          decoder;
	std::vector<std::vector<float>>            packet_samples;  // per-channel, reset per packet
	std::vector<float>                         interleaved;     // L,R,L,R,... ready for AudioData
};

struct Bink2Session {
	std::unique_ptr<Bink2Decoder>          decoder;
	std::unique_ptr<Bink2DecodedFrame>     prev_frame;
	// Bytes provided to `bink2_open`. The decoder copies the buffer
	// internally (Open_Memory takes a copy), so we don't need to keep
	// this around once decoder is constructed — but holding it costs
	// nothing and simplifies lifetime.
	std::vector<uint8_t>                   file_bytes;
	// Index of the last successfully decoded frame, or -1 if none.
	// Used to verify the caller decodes in monotonic order (required
	// for correct inter-frame reconstruction).
	int64_t                                last_decoded_frame = -1;

	// One state per audio track, lazy-initialised by
	// `bink2_audio_init`. Empty until the JS caller decides which
	// tracks it wants to decode.
	std::vector<Bink2AudioTrackState>      audio_states;
};

// Single global session. The TS wrapper instantiates a fresh WebAssembly
// module per Bink2Decoder JS object, so there is exactly one session per
// WASM instance.
Bink2Session* g_session = nullptr;

}  // namespace

/*
 * ---------------------------------------------------------------------
 * Allocation helpers
 * ---------------------------------------------------------------------
 *
 * The TS wrapper allocates buffers in WASM memory via `bink2_malloc`
 * (e.g. to hold the .bk2 file bytes before calling `bink2_open`) and
 * frees them via `bink2_free`. Plain malloc/free pass-throughs.
 */

EXPORT void* bink2_malloc(size_t n) { return std::malloc(n); }
EXPORT void  bink2_free(void* p) { std::free(p); }

/*
 * ---------------------------------------------------------------------
 * Session lifecycle
 * ---------------------------------------------------------------------
 */

/**
 * Open a .bk2 file from a memory buffer. The buffer at `data..data+len`
 * is copied internally; the caller may free it after this returns.
 *
 * Returns 1 on success, 0 on failure.
 */
EXPORT int bink2_open(const uint8_t* data, size_t len)
{
	if (g_session) {
		delete g_session;
		g_session = nullptr;
	}
	auto session = std::make_unique<Bink2Session>();
	session->file_bytes.assign(data, data + len);
	session->decoder = std::make_unique<Bink2Decoder>();
	if (!session->decoder->Open_Memory(session->file_bytes.data(), session->file_bytes.size())) {
		return 0;
	}
	const Bink2Header& hdr = session->decoder->Header();
	if (!hdr.Is_Valid() || hdr.frame_count == 0) return 0;
	g_session = session.release();
	return 1;
}

/** Close the current session and free its resources. */
EXPORT void bink2_close()
{
	delete g_session;
	g_session = nullptr;
}

/*
 * ---------------------------------------------------------------------
 * Header / info accessors
 * ---------------------------------------------------------------------
 *
 * Each is a single scalar getter so the TS wrapper can populate a
 * plain JS object with the fields it cares about. Returning a struct
 * across the WASM ABI would require either a pointer-out parameter
 * or a memory layout the TS side replicates exactly; per-field
 * accessors are simpler and cheap.
 */

EXPORT uint32_t bink2_width()         { return g_session ? g_session->decoder->Header().width : 0; }
EXPORT uint32_t bink2_height()        { return g_session ? g_session->decoder->Header().height : 0; }
EXPORT uint32_t bink2_frame_count()   { return g_session ? g_session->decoder->Header().frame_count : 0; }
EXPORT uint32_t bink2_fps_num()       { return g_session ? g_session->decoder->Header().fps_num : 0; }
EXPORT uint32_t bink2_fps_den()       { return g_session ? g_session->decoder->Header().fps_den : 0; }
EXPORT uint32_t bink2_audio_tracks()  { return g_session ? g_session->decoder->Header().audio_track_count : 0; }
EXPORT uint32_t bink2_has_alpha()     { return g_session && g_session->decoder->Header().Has_Alpha() ? 1u : 0u; }

/** True iff the frame index entry at `i` is marked as a keyframe. */
EXPORT uint32_t bink2_is_keyframe(uint32_t i)
{
	if (!g_session) return 0;
	const Bink2FrameIndexEntry* e = g_session->decoder->Frame_Entry(i);
	return (e && e->keyframe) ? 1u : 0u;
}

/*
 * ---------------------------------------------------------------------
 * Frame decode
 * ---------------------------------------------------------------------
 */

// After a successful `bink2_decode_frame`, these accessors return the
// geometry + pointers to the YUV planes inside WASM memory. The
// underlying storage lives in `g_session->prev_frame`; it remains
// valid until the next `bink2_decode_frame` or `bink2_close` call.
EXPORT uint32_t bink2_frame_aligned_width()  { return g_session && g_session->prev_frame ? g_session->prev_frame->aligned_width : 0; }
EXPORT uint32_t bink2_frame_aligned_height() { return g_session && g_session->prev_frame ? g_session->prev_frame->aligned_height : 0; }
EXPORT uint32_t bink2_frame_luma_stride()    { return g_session && g_session->prev_frame ? g_session->prev_frame->luma_stride : 0; }
EXPORT uint32_t bink2_frame_chroma_stride()  { return g_session && g_session->prev_frame ? g_session->prev_frame->chroma_stride : 0; }

EXPORT const uint8_t* bink2_frame_y_ptr() { return (g_session && g_session->prev_frame) ? g_session->prev_frame->y.data() : nullptr; }
EXPORT const uint8_t* bink2_frame_u_ptr() { return (g_session && g_session->prev_frame) ? g_session->prev_frame->u.data() : nullptr; }
EXPORT const uint8_t* bink2_frame_v_ptr() { return (g_session && g_session->prev_frame) ? g_session->prev_frame->v.data() : nullptr; }
EXPORT const uint8_t* bink2_frame_a_ptr() {
	if (!g_session || !g_session->prev_frame) return nullptr;
	auto& a = g_session->prev_frame->a;
	return a.empty() ? nullptr : a.data();
}

EXPORT uint32_t bink2_frame_y_len() { return g_session && g_session->prev_frame ? (uint32_t)g_session->prev_frame->y.size() : 0; }
EXPORT uint32_t bink2_frame_u_len() { return g_session && g_session->prev_frame ? (uint32_t)g_session->prev_frame->u.size() : 0; }
EXPORT uint32_t bink2_frame_v_len() { return g_session && g_session->prev_frame ? (uint32_t)g_session->prev_frame->v.size() : 0; }
EXPORT uint32_t bink2_frame_a_len() { return g_session && g_session->prev_frame ? (uint32_t)g_session->prev_frame->a.size() : 0; }

/**
 * Decode frame `index`. The decoder relies on the previously decoded
 * frame being held in-session for inter-frame reconstruction, so
 * callers MUST iterate frames in monotonic order. A non-monotonic
 * call (e.g. asking for frame 100 after frame 50) will fail unless
 * the requested frame is a keyframe.
 *
 * After a successful call, the YUV/A planes for the decoded frame
 * are accessible via `bink2_frame_*_ptr()` / `bink2_frame_*_len()`
 * until the next `bink2_decode_frame` or `bink2_close`.
 *
 * Returns 1 on success, 0 on failure.
 */
EXPORT int bink2_decode_frame(uint32_t index)
{
	if (!g_session || !g_session->decoder) return 0;
	const Bink2FrameIndexEntry* entry = g_session->decoder->Frame_Entry(index);
	if (!entry) return 0;
	const bool is_kf = entry->keyframe || index == 0;

	// For inter-frames we need the previous decoded frame as a
	// reference. The caller is expected to step monotonically; if
	// they jump backwards or skip frames the reconstruction will be
	// wrong. We don't enforce this strictly because the caller may
	// legitimately seek to a keyframe and resume forward iteration,
	// but we do require `prev_frame` to be present for inter-frames.
	if (!is_kf && !g_session->prev_frame) return 0;

	auto next = std::make_unique<Bink2DecodedFrame>();
	const bool ok = Bink2DecodeFrameByIndex(
		*g_session->decoder, (size_t)index,
		g_session->prev_frame.get(), *next);
	if (!ok || !next->complete) return 0;

	g_session->prev_frame = std::move(next);
	g_session->last_decoded_frame = (int64_t)index;
	return 1;
}

/*
 * ---------------------------------------------------------------------
 * Audio
 * ---------------------------------------------------------------------
 *
 * Container audio is per-frame: each video frame's packet has an
 * optional `u32 audio_size + audio_bytes` prefix per track. The
 * decoder owns rolling overlap state across blocks, so the JS caller
 * must iterate audio packets in monotonic frame order (same as video).
 *
 * Flow:
 *   1. `bink2_audio_init(track_index)` once per track the caller cares
 *      about. Returns 1 on success; idempotent (safe to call again
 *      with the same index, which resets the decoder state).
 *   2. `bink2_audio_decode_packet(frame_index, track_index)` per
 *      frame. Returns the number of *frames* of samples decoded
 *      (i.e. samples-per-channel; multiply by `bink2_audio_channels`
 *      to get total sample count). Zero is a valid "this frame has
 *      no audio in this track" response.
 *   3. `bink2_audio_interleaved_ptr/_len()` to read the just-decoded
 *      packet as an interleaved Float32 buffer that maps 1:1 onto
 *      WebCodecs `AudioData({format: 'f32'})`.
 */

EXPORT uint32_t bink2_audio_track_count()
{
	return g_session ? (uint32_t)g_session->decoder->Audio_Tracks().size() : 0;
}

EXPORT uint32_t bink2_audio_track_sample_rate(uint32_t i)
{
	if (!g_session) return 0;
	const auto& tracks = g_session->decoder->Audio_Tracks();
	return i < tracks.size() ? tracks[i].sample_rate : 0;
}

EXPORT uint32_t bink2_audio_track_flags(uint32_t i)
{
	if (!g_session) return 0;
	const auto& tracks = g_session->decoder->Audio_Tracks();
	return i < tracks.size() ? tracks[i].flags : 0;
}

EXPORT uint32_t bink2_audio_track_stereo(uint32_t i)
{
	if (!g_session) return 0;
	const auto& tracks = g_session->decoder->Audio_Tracks();
	return (i < tracks.size() && tracks[i].Stereo()) ? 1u : 0u;
}

EXPORT uint32_t bink2_audio_track_use_dct(uint32_t i)
{
	if (!g_session) return 0;
	const auto& tracks = g_session->decoder->Audio_Tracks();
	return (i < tracks.size() && tracks[i].Use_DCT()) ? 1u : 0u;
}

EXPORT uint32_t bink2_audio_track_id(uint32_t i)
{
	if (!g_session) return 0;
	const auto& tracks = g_session->decoder->Audio_Tracks();
	return i < tracks.size() ? tracks[i].id : 0;
}

/**
 * Initialise (or reset) the decoder for audio track `i`. Returns
 * 1 on success, 0 if the track is out of range or the decoder
 * rejects the parameters.
 */
EXPORT int bink2_audio_init(uint32_t i)
{
	if (!g_session) return 0;
	const auto& tracks = g_session->decoder->Audio_Tracks();
	if (i >= tracks.size()) return 0;

	// Grow `audio_states` to at least i+1 entries. The lazy growth
	// makes a "I only want the first track" use-case cheap.
	if (g_session->audio_states.size() <= i) {
		g_session->audio_states.resize(i + 1);
	}
	auto& state = g_session->audio_states[i];
	// Re-init from scratch (caller may legitimately reset).
	state.decoder = Bink2AudioDecoder{};
	state.packet_samples.clear();
	state.interleaved.clear();

	const auto& track = tracks[i];
	const char rev = g_session->decoder->Header().Revision();
	const bool ok = Bink2AudioInit(
		state.decoder,
		track.sample_rate,
		track.Use_DCT(),
		track.Stereo(),
		rev == 'b');
	return ok ? 1 : 0;
}

EXPORT uint32_t bink2_audio_channels(uint32_t i)
{
	if (!g_session || i >= g_session->audio_states.size()) return 0;
	return g_session->audio_states[i].decoder.channels;
}

EXPORT uint32_t bink2_audio_decoded_sample_rate(uint32_t i)
{
	if (!g_session || i >= g_session->audio_states.size()) return 0;
	return g_session->audio_states[i].decoder.sample_rate;
}

/**
 * Decode audio track `track_index`'s sub-packet from frame
 * `frame_index`. On success returns the number of samples-per-channel
 * decoded (which may be zero for "no audio in this frame"). On
 * failure returns UINT32_MAX (we can't use 0 as a sentinel because
 * 0 is a legitimate empty-packet response).
 *
 * The decoded samples are accessible via `bink2_audio_interleaved_ptr`
 * (and `_len`) until the next call to this function for the same
 * track.
 */
EXPORT uint32_t bink2_audio_decode_packet(uint32_t frame_index, uint32_t track_index)
{
	if (!g_session) return UINT32_MAX;
	if (track_index >= g_session->audio_states.size()) return UINT32_MAX;
	auto& state = g_session->audio_states[track_index];
	if (!state.decoder.ready) return UINT32_MAX;

	std::vector<uint8_t> packet;
	if (!g_session->decoder->Read_Audio_Packet(frame_index, track_index, packet)) {
		return UINT32_MAX;
	}
	// Empty packets are legitimate: many frames carry no new audio
	// for some tracks. Surface as "0 samples decoded".
	if (packet.empty()) {
		state.interleaved.clear();
		return 0;
	}
	// Reset per-packet planar buffer; Bink2AudioDecodePacket appends.
	state.packet_samples.assign(state.decoder.channels, {});
	if (!Bink2AudioDecodePacket(state.decoder, packet, state.packet_samples)) {
		return UINT32_MAX;
	}

	// Interleave planar → flat: L,R,L,R,...  WebCodecs AudioData
	// with format='f32' wants this layout (vs 'f32-planar' which
	// would let us skip the copy, but f32 interleaved is the more
	// portable choice).
	const uint32_t nch = state.decoder.channels;
	const size_t per_ch = state.packet_samples.empty() ? 0 : state.packet_samples[0].size();
	state.interleaved.resize(per_ch * nch);
	for (size_t s = 0; s < per_ch; ++s) {
		for (uint32_t c = 0; c < nch; ++c) {
			state.interleaved[s * nch + c] = state.packet_samples[c][s];
		}
	}
	return (uint32_t)per_ch;
}

EXPORT const float* bink2_audio_interleaved_ptr(uint32_t track_index)
{
	if (!g_session || track_index >= g_session->audio_states.size()) return nullptr;
	auto& state = g_session->audio_states[track_index];
	return state.interleaved.empty() ? nullptr : state.interleaved.data();
}

EXPORT uint32_t bink2_audio_interleaved_len(uint32_t track_index)
{
	if (!g_session || track_index >= g_session->audio_states.size()) return 0;
	return (uint32_t)g_session->audio_states[track_index].interleaved.size();
}
