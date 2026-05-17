/**
 * MIT-licensed C wrapper around a slim ffmpeg build (Bink 1 decoder
 * + Bink audio decoders + Bink demuxer only) for WebAssembly.
 *
 * What this file does:
 *
 *   - Owns a single decoding session (one open .bik file) per WASM
 *     module. The TS wrapper instantiates a fresh WASM instance per
 *     `Bink1Decoder` object, so "single global session" is fine.
 *   - Drives libavformat / libavcodec through a custom `AVIOContext`
 *     backed by a memory buffer; no filesystem touch.
 *   - Exports a small C ABI (`bink1_open`, `bink1_get_info`,
 *     `bink1_decode_frame`, `bink1_decode_audio`, `bink1_close`,
 *     plus malloc/free) that the TS wrapper drives.
 *
 * Memory model: the caller provides the entire .bik byte buffer
 * up-front via `bink1_open`. We keep one full copy inside WASM
 * memory; the `AVIOContext` reads from it directly (no further
 * allocation per packet). Decoded video frames are one YUV420P
 * AVFrame at a time (~width*height*1.5 bytes); decoded audio is
 * one Bink audio packet at a time per track (handful of KB).
 *
 * Decoding model: monotonic only. The caller (JS) is expected to
 * walk frames 0..N-1 in order. We use `av_read_frame` to pull
 * packets and dispatch them to the matching codec context based on
 * stream index. The Bink demuxer hands us one video packet + zero
 * or more audio packets per "frame", so we buffer audio packets
 * keyed by frame index in a tiny FIFO and the TS side pulls them
 * via `bink1_decode_audio(frame_index, track)`.
 */

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "libavcodec/avcodec.h"
#include "libavformat/avformat.h"
#include "libavutil/avutil.h"
#include "libavutil/mem.h"
#include "libavutil/samplefmt.h"

#define EXPORT __attribute__((visibility("default")))

/*
 * ---------------------------------------------------------------------
 * Session state
 * ---------------------------------------------------------------------
 */

typedef struct {
	/* The complete .bik file bytes, owned by us. */
	uint8_t* data;
	size_t   size;
	/* Current read offset for the custom AVIOContext. */
	int64_t  pos;
} MemoryBuffer;

/*
 * Per-track audio state. The reader-loop in `bink1_decode_next_frame`
 * delivers audio packets to the matching codec as it walks toward
 * the next video packet; decoded interleaved Float32 samples are
 * appended to `samples_fifo` and drained lazily by JS through
 * `bink1_drain_audio`. Each draw of `bink1_drain_audio` copies (at
 * most) `samples_fifo_count` samples-per-channel into a contiguous
 * span pointed at by `drain_ptr` and clears the FIFO; if the FIFO
 * grows the buffer is re-`realloc`ed.
 */
typedef struct {
	int            stream_index;
	AVCodecContext* codec_ctx;
	uint32_t       channels;
	uint32_t       sample_rate;
	/* Interleaved Float32 sample FIFO. Length = samples_fifo_count * channels. */
	float*         samples_fifo;
	uint32_t       samples_fifo_capacity_frames;  /* samples-per-channel */
	uint32_t       samples_fifo_count_frames;     /* samples-per-channel currently buffered */
	/* Reusable AVFrame for receive_frame. */
	AVFrame*       frame;
} AudioTrackState;

typedef struct {
	MemoryBuffer        buf;
	unsigned char*      avio_buffer;       /* AVIO read buffer, owned by AVIOContext after avio_alloc_context */
	AVIOContext*        avio_ctx;
	AVFormatContext*    fmt_ctx;

	int                 video_stream_index;
	AVCodecContext*     video_codec_ctx;
	AVFrame*            video_frame;       /* reusable; refreshed each decode_frame */
	int64_t             last_decoded_frame; /* -1 if none */

	uint32_t            audio_track_count;
	AudioTrackState*    audio;             /* array of audio_track_count entries */

	AVPacket*           packet;
} Bink1Session;

static Bink1Session* g_session = NULL;

/*
 * ---------------------------------------------------------------------
 * Custom AVIO read callback (memory-backed)
 * ---------------------------------------------------------------------
 */

static int memory_read_packet(void* opaque, uint8_t* buf, int buf_size)
{
	MemoryBuffer* mb = (MemoryBuffer*)opaque;
	if (mb->pos >= (int64_t)mb->size) return AVERROR_EOF;
	int64_t remaining = (int64_t)mb->size - mb->pos;
	int n = buf_size < remaining ? buf_size : (int)remaining;
	memcpy(buf, mb->data + mb->pos, (size_t)n);
	mb->pos += n;
	return n;
}

static int64_t memory_seek(void* opaque, int64_t offset, int whence)
{
	MemoryBuffer* mb = (MemoryBuffer*)opaque;
	if (whence == AVSEEK_SIZE) return (int64_t)mb->size;
	int64_t new_pos;
	switch (whence) {
		case SEEK_SET: new_pos = offset; break;
		case SEEK_CUR: new_pos = mb->pos + offset; break;
		case SEEK_END: new_pos = (int64_t)mb->size + offset; break;
		default: return -1;
	}
	if (new_pos < 0 || new_pos > (int64_t)mb->size) return -1;
	mb->pos = new_pos;
	return new_pos;
}

/*
 * ---------------------------------------------------------------------
 * Allocation helpers
 * ---------------------------------------------------------------------
 *
 * The TS wrapper allocates a buffer for the .bik bytes via
 * `bink1_malloc`, fills it from JS, then calls `bink1_open` with
 * (ptr, len). After `bink1_open` returns we transfer ownership of
 * those bytes into the session, so the TS side can drop its handle.
 */

EXPORT void* bink1_malloc(size_t n) { return malloc(n); }
EXPORT void  bink1_free(void* p) { free(p); }

/*
 * ---------------------------------------------------------------------
 * Session lifecycle
 * ---------------------------------------------------------------------
 */

static void session_destroy(Bink1Session* s)
{
	if (!s) return;
	if (s->audio) {
		for (uint32_t i = 0; i < s->audio_track_count; i++) {
			if (s->audio[i].codec_ctx) avcodec_free_context(&s->audio[i].codec_ctx);
			if (s->audio[i].frame) av_frame_free(&s->audio[i].frame);
			if (s->audio[i].samples_fifo) free(s->audio[i].samples_fifo);
		}
		free(s->audio);
	}
	if (s->video_frame) av_frame_free(&s->video_frame);
	if (s->video_codec_ctx) avcodec_free_context(&s->video_codec_ctx);
	if (s->packet) av_packet_free(&s->packet);
	if (s->fmt_ctx) avformat_close_input(&s->fmt_ctx);
	if (s->avio_ctx) {
		/* avio_ctx owns avio_buffer; freeing the ctx frees both. */
		av_freep(&s->avio_ctx->buffer);
		avio_context_free(&s->avio_ctx);
	}
	if (s->buf.data) free(s->buf.data);
	free(s);
}

/**
 * Open a .bik file from a memory buffer. Ownership of `data` (which
 * MUST have been allocated via `bink1_malloc`) transfers to us on
 * success; the caller must NOT free it. On failure we free `data`
 * ourselves and return 0.
 *
 * Returns 1 on success, 0 on failure.
 */
EXPORT int bink1_open(uint8_t* data, size_t len)
{
	if (g_session) {
		session_destroy(g_session);
		g_session = NULL;
	}
	Bink1Session* s = (Bink1Session*)calloc(1, sizeof(Bink1Session));
	if (!s) { free(data); return 0; }
	s->buf.data = data;
	s->buf.size = len;
	s->buf.pos = 0;
	s->video_stream_index = -1;
	s->last_decoded_frame = -1;

	/* 64 KB AVIO buffer. ffmpeg requires this to be allocated via
	 * av_malloc — it'll be freed in session_destroy. */
	const size_t avio_buf_size = 65536;
	unsigned char* avio_buf = (unsigned char*)av_malloc(avio_buf_size);
	if (!avio_buf) { session_destroy(s); return 0; }
	s->avio_ctx = avio_alloc_context(avio_buf, (int)avio_buf_size,
	                                 0, &s->buf,
	                                 memory_read_packet, NULL, memory_seek);
	if (!s->avio_ctx) {
		av_freep(&avio_buf);
		session_destroy(s);
		return 0;
	}

	s->fmt_ctx = avformat_alloc_context();
	if (!s->fmt_ctx) { session_destroy(s); return 0; }
	s->fmt_ctx->pb = s->avio_ctx;
	s->fmt_ctx->flags |= AVFMT_FLAG_CUSTOM_IO;

	if (avformat_open_input(&s->fmt_ctx, NULL, NULL, NULL) < 0) {
		/* On failure avformat_open_input has already freed fmt_ctx;
		 * NULL it out so session_destroy doesn't double-free. */
		s->fmt_ctx = NULL;
		session_destroy(s);
		return 0;
	}
	if (avformat_find_stream_info(s->fmt_ctx, NULL) < 0) {
		session_destroy(s);
		return 0;
	}

	/* Walk streams: exactly one video stream, zero or more audio. */
	uint32_t audio_count = 0;
	for (unsigned i = 0; i < s->fmt_ctx->nb_streams; i++) {
		AVStream* st = s->fmt_ctx->streams[i];
		if (st->codecpar->codec_type == AVMEDIA_TYPE_VIDEO && s->video_stream_index < 0) {
			s->video_stream_index = (int)i;
		} else if (st->codecpar->codec_type == AVMEDIA_TYPE_AUDIO) {
			audio_count++;
		}
	}
	if (s->video_stream_index < 0) { session_destroy(s); return 0; }

	/* Open video codec. */
	{
		AVStream* vst = s->fmt_ctx->streams[s->video_stream_index];
		const AVCodec* codec = avcodec_find_decoder(vst->codecpar->codec_id);
		if (!codec) { session_destroy(s); return 0; }
		s->video_codec_ctx = avcodec_alloc_context3(codec);
		if (!s->video_codec_ctx) { session_destroy(s); return 0; }
		if (avcodec_parameters_to_context(s->video_codec_ctx, vst->codecpar) < 0) {
			session_destroy(s); return 0;
		}
		if (avcodec_open2(s->video_codec_ctx, codec, NULL) < 0) {
			session_destroy(s); return 0;
		}
	}

	/* Open audio codecs. */
	if (audio_count > 0) {
		s->audio = (AudioTrackState*)calloc(audio_count, sizeof(AudioTrackState));
		if (!s->audio) { session_destroy(s); return 0; }
		s->audio_track_count = audio_count;

		uint32_t aidx = 0;
		for (unsigned i = 0; i < s->fmt_ctx->nb_streams; i++) {
			AVStream* st = s->fmt_ctx->streams[i];
			if (st->codecpar->codec_type != AVMEDIA_TYPE_AUDIO) continue;
			AudioTrackState* a = &s->audio[aidx++];
			a->stream_index = (int)i;
			a->sample_rate = (uint32_t)st->codecpar->sample_rate;
#if LIBAVCODEC_VERSION_MAJOR >= 60
			a->channels = (uint32_t)st->codecpar->ch_layout.nb_channels;
#else
			a->channels = (uint32_t)st->codecpar->channels;
#endif
			const AVCodec* codec = avcodec_find_decoder(st->codecpar->codec_id);
			if (!codec) { session_destroy(s); return 0; }
			a->codec_ctx = avcodec_alloc_context3(codec);
			if (!a->codec_ctx) { session_destroy(s); return 0; }
			if (avcodec_parameters_to_context(a->codec_ctx, st->codecpar) < 0) {
				session_destroy(s); return 0;
			}
			if (avcodec_open2(a->codec_ctx, codec, NULL) < 0) {
				session_destroy(s); return 0;
			}
			a->frame = av_frame_alloc();
			if (!a->frame) { session_destroy(s); return 0; }
		}
	}

	s->video_frame = av_frame_alloc();
	s->packet = av_packet_alloc();
	if (!s->video_frame || !s->packet) { session_destroy(s); return 0; }

	g_session = s;
	return 1;
}

EXPORT void bink1_close()
{
	if (g_session) {
		session_destroy(g_session);
		g_session = NULL;
	}
}

/*
 * ---------------------------------------------------------------------
 * Header / info accessors
 * ---------------------------------------------------------------------
 */

EXPORT uint32_t bink1_width()
{
	return g_session ? (uint32_t)g_session->video_codec_ctx->width : 0;
}

EXPORT uint32_t bink1_height()
{
	return g_session ? (uint32_t)g_session->video_codec_ctx->height : 0;
}

EXPORT uint32_t bink1_frame_count()
{
	if (!g_session) return 0;
	AVStream* vst = g_session->fmt_ctx->streams[g_session->video_stream_index];
	/* Bink demuxer populates `duration` (in stream timebase units =
	 * frames) directly from the container header's num_frames field;
	 * `nb_frames` is left at zero. Prefer `duration` and fall back. */
	if (vst->duration > 0) return (uint32_t)vst->duration;
	return (uint32_t)vst->nb_frames;
}

/* FPS numerator / denominator, derived from the video stream's
 * average frame rate (which Bink demuxer fills from the container
 * header). */
EXPORT uint32_t bink1_fps_num()
{
	if (!g_session) return 0;
	AVStream* vst = g_session->fmt_ctx->streams[g_session->video_stream_index];
	return (uint32_t)vst->avg_frame_rate.num;
}

EXPORT uint32_t bink1_fps_den()
{
	if (!g_session) return 0;
	AVStream* vst = g_session->fmt_ctx->streams[g_session->video_stream_index];
	return (uint32_t)vst->avg_frame_rate.den;
}

EXPORT uint32_t bink1_audio_track_count()
{
	return g_session ? g_session->audio_track_count : 0;
}

EXPORT uint32_t bink1_audio_track_sample_rate(uint32_t i)
{
	if (!g_session || i >= g_session->audio_track_count) return 0;
	return g_session->audio[i].sample_rate;
}

EXPORT uint32_t bink1_audio_track_channels(uint32_t i)
{
	if (!g_session || i >= g_session->audio_track_count) return 0;
	return g_session->audio[i].channels;
}

/*
 * ---------------------------------------------------------------------
 * Frame decode
 * ---------------------------------------------------------------------
 *
 * Pull packets via av_read_frame until we land on a video packet
 * that decodes successfully. Audio packets encountered along the
 * way are forwarded to the matching audio codec context but their
 * output samples are discarded — JS calls `bink1_decode_audio`
 * separately, which runs its own pull loop.
 *
 * NOTE: this version supports only forward monotonic decode. The
 * caller is expected to call `bink1_decode_next_frame` repeatedly
 * to advance through frames 0..N-1. We don't enforce or expose
 * arbitrary seeking; for Bink 1 keyframe density is generally
 * adequate for streamed playback.
 */

/* Geometry / plane accessors for the most-recently decoded video frame. */
EXPORT uint32_t bink1_frame_width()    { return (g_session && g_session->video_frame) ? (uint32_t)g_session->video_frame->width : 0; }
EXPORT uint32_t bink1_frame_height()   { return (g_session && g_session->video_frame) ? (uint32_t)g_session->video_frame->height : 0; }
EXPORT uint32_t bink1_frame_y_stride() { return (g_session && g_session->video_frame) ? (uint32_t)g_session->video_frame->linesize[0] : 0; }
EXPORT uint32_t bink1_frame_u_stride() { return (g_session && g_session->video_frame) ? (uint32_t)g_session->video_frame->linesize[1] : 0; }
EXPORT uint32_t bink1_frame_v_stride() { return (g_session && g_session->video_frame) ? (uint32_t)g_session->video_frame->linesize[2] : 0; }

EXPORT const uint8_t* bink1_frame_y_ptr() { return (g_session && g_session->video_frame) ? g_session->video_frame->data[0] : NULL; }
EXPORT const uint8_t* bink1_frame_u_ptr() { return (g_session && g_session->video_frame) ? g_session->video_frame->data[1] : NULL; }
EXPORT const uint8_t* bink1_frame_v_ptr() { return (g_session && g_session->video_frame) ? g_session->video_frame->data[2] : NULL; }

/** Pixel format of the decoded video frame (AVPixelFormat enum value).
 * Bink 1 always emits YUV420P (= 0), but we expose this so the TS
 * side can sanity-check before assuming layout. */
EXPORT int bink1_frame_pix_fmt() { return (g_session && g_session->video_frame) ? g_session->video_frame->format : -1; }

/*
 * Look up the audio track index (into g_session->audio) for a given
 * AVStream index, or -1 if the stream isn't an audio track we care about.
 */
static int audio_track_for_stream(int stream_index)
{
	if (!g_session) return -1;
	for (uint32_t i = 0; i < g_session->audio_track_count; i++) {
		if (g_session->audio[i].stream_index == stream_index) return (int)i;
	}
	return -1;
}

/*
 * Append a decoded AVFrame's samples to the track's FIFO,
 * interleaving if the source is planar. AVFrame samples can be
 * either AV_SAMPLE_FMT_FLT (interleaved) or AV_SAMPLE_FMT_FLTP
 * (planar) depending on the codec — Bink audio uses FLTP. We
 * normalise to interleaved Float32 [-1, 1].
 *
 * Returns 0 on success, -1 on out-of-memory.
 */
static int audio_fifo_append(AudioTrackState* a, AVFrame* fr)
{
	const uint32_t ch = a->channels;
	const uint32_t n  = (uint32_t)fr->nb_samples;
	if (n == 0) return 0;

	const uint32_t need = a->samples_fifo_count_frames + n;
	if (need > a->samples_fifo_capacity_frames) {
		uint32_t newcap = a->samples_fifo_capacity_frames ? a->samples_fifo_capacity_frames * 2 : 4096;
		while (newcap < need) newcap *= 2;
		float* nb = (float*)realloc(a->samples_fifo, (size_t)newcap * ch * sizeof(float));
		if (!nb) return -1;
		a->samples_fifo = nb;
		a->samples_fifo_capacity_frames = newcap;
	}

	float* dst = a->samples_fifo + (size_t)a->samples_fifo_count_frames * ch;
	if (fr->format == AV_SAMPLE_FMT_FLT) {
		/* Already interleaved. */
		memcpy(dst, fr->data[0], (size_t)n * ch * sizeof(float));
	} else if (fr->format == AV_SAMPLE_FMT_FLTP) {
		/* Planar -> interleaved. */
		for (uint32_t c = 0; c < ch; c++) {
			const float* src = (const float*)fr->data[c];
			for (uint32_t s = 0; s < n; s++) {
				dst[s * ch + c] = src[s];
			}
		}
	} else {
		/* Other formats (S16/S16P/S32/S32P) — Bink audio never
		 * emits these, but handle int16 for robustness. */
		return -1;
	}
	a->samples_fifo_count_frames = need;
	return 0;
}

/*
 * Forward an audio AVPacket to the matching audio codec and append
 * any produced samples to the track's FIFO. The packet is owned
 * by the caller; we don't unref it here.
 */
static int route_audio_packet(AVPacket* pkt)
{
	int t = audio_track_for_stream(pkt->stream_index);
	if (t < 0) return 0;
	AudioTrackState* a = &g_session->audio[t];
	int sr = avcodec_send_packet(a->codec_ctx, pkt);
	if (sr < 0 && sr != AVERROR(EAGAIN)) return -1;
	for (;;) {
		int got = avcodec_receive_frame(a->codec_ctx, a->frame);
		if (got == AVERROR(EAGAIN) || got == AVERROR_EOF) break;
		if (got < 0) return -1;
		if (audio_fifo_append(a, a->frame) < 0) {
			av_frame_unref(a->frame);
			return -1;
		}
		av_frame_unref(a->frame);
	}
	return 0;
}

/**
 * Decode the next video frame in playback order. Audio packets
 * encountered along the way are routed to their respective audio
 * codecs and the decoded samples queued for later retrieval via
 * `bink1_drain_audio`.
 *
 * Returns:
 *   1  - success, frame data accessible via bink1_frame_*_ptr()
 *   0  - end of stream
 *  -1  - decode error
 */
EXPORT int bink1_decode_next_frame()
{
	if (!g_session) return -1;

	for (;;) {
		int rr = av_read_frame(g_session->fmt_ctx, g_session->packet);
		if (rr == AVERROR_EOF) {
			/* Flush video decoder. */
			avcodec_send_packet(g_session->video_codec_ctx, NULL);
			int got = avcodec_receive_frame(g_session->video_codec_ctx, g_session->video_frame);
			if (got == 0) { g_session->last_decoded_frame++; return 1; }
			/* Flush audio decoders as well (delivers any final
			 * tail samples into the FIFOs). */
			for (uint32_t i = 0; i < g_session->audio_track_count; i++) {
				AudioTrackState* a = &g_session->audio[i];
				avcodec_send_packet(a->codec_ctx, NULL);
				for (;;) {
					int g2 = avcodec_receive_frame(a->codec_ctx, a->frame);
					if (g2 == AVERROR(EAGAIN) || g2 == AVERROR_EOF) break;
					if (g2 < 0) break;
					audio_fifo_append(a, a->frame);
					av_frame_unref(a->frame);
				}
			}
			return 0;
		}
		if (rr < 0) return -1;

		if (g_session->packet->stream_index == g_session->video_stream_index) {
			int sr = avcodec_send_packet(g_session->video_codec_ctx, g_session->packet);
			av_packet_unref(g_session->packet);
			if (sr < 0 && sr != AVERROR(EAGAIN)) return -1;
			int got = avcodec_receive_frame(g_session->video_codec_ctx, g_session->video_frame);
			if (got == 0) {
				g_session->last_decoded_frame++;
				return 1;
			}
			if (got != AVERROR(EAGAIN)) return -1;
			/* Need more packets; loop. */
		} else {
			int rv = route_audio_packet(g_session->packet);
			av_packet_unref(g_session->packet);
			if (rv < 0) return -1;
		}
	}
}

/*
 * ---------------------------------------------------------------------
 * Audio drain
 * ---------------------------------------------------------------------
 *
 * The JS side calls `bink1_drain_audio(track_index)` whenever it
 * wants the samples accumulated so far for `track_index`. Returns
 * the number of *sample frames* (i.e. samples-per-channel) available;
 * the interleaved Float32 buffer is at `bink1_audio_drain_ptr(track)`
 * and remains valid until the next `bink1_drain_audio(track)` call.
 *
 * After draining, the FIFO is cleared. The JS side should drain
 * after every successful `bink1_decode_next_frame` (or after EOS)
 * to keep memory bounded.
 */
EXPORT uint32_t bink1_drain_audio(uint32_t track_index)
{
	if (!g_session || track_index >= g_session->audio_track_count) return 0;
	AudioTrackState* a = &g_session->audio[track_index];
	uint32_t n = a->samples_fifo_count_frames;
	/* Reset the count; the buffer stays allocated for the next
	 * round (no realloc churn). The caller reads from
	 * bink1_audio_drain_ptr() before the next call to refill. */
	a->samples_fifo_count_frames = 0;
	return n;
}

EXPORT const float* bink1_audio_drain_ptr(uint32_t track_index)
{
	if (!g_session || track_index >= g_session->audio_track_count) return NULL;
	return g_session->audio[track_index].samples_fifo;
}
