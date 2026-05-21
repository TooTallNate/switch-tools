/**
 * MIT-licensed C wrapper around a "no codecs" FFmpeg build. This
 * module exposes the libav* C API for dynamically-loaded codec
 * extensions to use, plus a single-session decoding ABI that the
 * TS layer drives.
 *
 * Design (vs. the monolithic bink1-wasm):
 *
 *   - The base WASM ships with libavutil + libavcodec + libavformat
 *     scaffolding but NO codecs, demuxers, or muxers. Extensions
 *     (compiled as wasm32-wasip1 `-shared` .so files, see
 *     quickjs-wasi for the precedent) carry the actual codec
 *     implementations.
 *
 *   - An extension exposes one or both of:
 *
 *         const FFCodec *ffmpeg_ext_<name>_codec_<n>(void);
 *         const AVInputFormat *ffmpeg_ext_<name>_demuxer_<n>(void);
 *
 *     The TS loader instantiates each extension, collects the
 *     codec/demuxer pointers it advertises, and registers them
 *     with the base via `ffmpeg_register_codec()` /
 *     `ffmpeg_register_demuxer()`. After all extensions are
 *     registered the TS layer calls `ffmpeg_open(data, size)` and
 *     the base picks the right demuxer (probe) + the right codec
 *     for each stream (by codec_id) automatically.
 *
 *   - We bypass FFmpeg's static codec / demuxer registries entirely.
 *     The base FFmpeg build has zero codecs / demuxers compiled in;
 *     our own static `g_codecs[]` / `g_demuxers[]` arrays are the
 *     only registries that matter. `avcodec_open2(ctx, codec_ptr)`
 *     is called with the matched pointer directly.
 *
 *   - Memory: the caller hands us the entire file's bytes up-front.
 *     A custom `AVIOContext` backed by a flat buffer means no
 *     filesystem touch is needed.
 *
 *   - Audio: zero or more audio streams are auto-decoded alongside
 *     video. Each track keeps an interleaved-Float32 FIFO; JS calls
 *     `ffmpeg_drain_audio(track)` after each video frame to retrieve
 *     accumulated samples.
 *
 * Single-session: one active decode at a time per WASM instance.
 * The TS wrapper creates a fresh WASM instance per decoder.
 */

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "libavcodec/avcodec.h"
#include "libavformat/avformat.h"
#include "libavutil/avutil.h"
#include "libavutil/mem.h"
#include "libavutil/imgutils.h"
#include "libavutil/samplefmt.h"

#define EXPORT __attribute__((visibility("default")))

/*
 * ---------------------------------------------------------------------
 * Registries
 * ---------------------------------------------------------------------
 *
 * Codecs and demuxers are registered by the TS loader at extension
 * load time. The arrays are sized for the foreseeable future (a few
 * codecs/demuxers per session is the norm); blowing the limit just
 * means more extensions can't register and we return -1.
 */

#define FF_MAX_REGISTERED_CODECS   32
#define FF_MAX_REGISTERED_DEMUXERS 16

static const AVCodec       *g_codecs[FF_MAX_REGISTERED_CODECS];
static int                  g_codec_count = 0;

static const AVInputFormat *g_demuxers[FF_MAX_REGISTERED_DEMUXERS];
static int                  g_demuxer_count = 0;

EXPORT int ffmpeg_register_codec(const AVCodec *codec)
{
	if (!codec || g_codec_count >= FF_MAX_REGISTERED_CODECS) return -1;
	g_codecs[g_codec_count++] = codec;
	return 0;
}

EXPORT int ffmpeg_register_demuxer(const AVInputFormat *demuxer)
{
	if (!demuxer || g_demuxer_count >= FF_MAX_REGISTERED_DEMUXERS) return -1;
	g_demuxers[g_demuxer_count++] = demuxer;
	return 0;
}

/* Look up a codec by codec_id (skipping any that don't match the
 * desired AVMediaType). Returns NULL if no registered codec matches. */
static const AVCodec *find_codec(enum AVCodecID id, enum AVMediaType want_type)
{
	for (int i = 0; i < g_codec_count; i++) {
		const AVCodec *c = g_codecs[i];
		if (c->id == id && c->type == want_type) return c;
	}
	return NULL;
}

/*
 * ---------------------------------------------------------------------
 * Session state
 * ---------------------------------------------------------------------
 */

typedef struct {
	uint8_t *data;   /* file bytes, owned by the session */
	size_t   size;
	int64_t  pos;
} MemoryBuffer;

typedef struct {
	int             stream_index;
	AVCodecContext *codec_ctx;
	AVFrame        *frame;
	uint32_t        channels;
	uint32_t        sample_rate;

	/* Interleaved Float32 FIFO. Length = count_frames * channels. */
	float    *samples_fifo;
	uint32_t  capacity_frames;
	uint32_t  count_frames;
} AudioTrackState;

typedef struct Session {
	MemoryBuffer     buf;
	AVIOContext     *avio;
	AVFormatContext *fmt_ctx;
	AVPacket        *packet;

	/* Video. */
	int              video_stream_index;
	AVCodecContext  *video_codec_ctx;
	AVFrame         *video_frame;

	/* Last-decoded video frame plane info, snapshotted on each
	 * successful decodeFrame(); JS reads these via accessors. */
	int      width, height;
	int      y_stride, u_stride, v_stride;
	const uint8_t *y_data, *u_data, *v_data;
	int64_t  frame_index;

	/* Audio tracks. */
	uint32_t           audio_track_count;
	AudioTrackState   *audio;
} Session;

static Session *g_session = NULL;

/*
 * ---------------------------------------------------------------------
 * Memory allocation pass-throughs for the TS wrapper.
 * ---------------------------------------------------------------------
 */

EXPORT void *ffmpeg_malloc(size_t n) { return malloc(n); }
EXPORT void  ffmpeg_free(void *p)    { free(p); }

/* Diagnostic: bump av_log verbosity. Pass `AV_LOG_DEBUG` (48) or
 * `AV_LOG_TRACE` (56) to see what the codec / demuxer is doing. */
EXPORT void ffmpeg_set_log_level(int level) { av_log_set_level(level); }

/*
 * ---------------------------------------------------------------------
 * AVIO callbacks (memory-backed)
 * ---------------------------------------------------------------------
 */

static int read_packet_cb(void *opaque, uint8_t *out, int buf_size)
{
	MemoryBuffer *b = (MemoryBuffer *)opaque;
	if (b->pos >= (int64_t)b->size) return AVERROR_EOF;
	int64_t remaining = (int64_t)b->size - b->pos;
	int n = (buf_size < remaining) ? buf_size : (int)remaining;
	memcpy(out, b->data + b->pos, (size_t)n);
	b->pos += n;
	return n;
}

static int64_t seek_cb(void *opaque, int64_t off, int whence)
{
	MemoryBuffer *b = (MemoryBuffer *)opaque;
	int64_t target;
	switch (whence) {
		case SEEK_SET: target = off;             break;
		case SEEK_CUR: target = b->pos + off;    break;
		case SEEK_END: target = (int64_t)b->size + off; break;
		case AVSEEK_SIZE: return (int64_t)b->size;
		default: return AVERROR(EINVAL);
	}
	if (target < 0 || target > (int64_t)b->size) return AVERROR(EINVAL);
	b->pos = target;
	return b->pos;
}

/*
 * ---------------------------------------------------------------------
 * Session lifecycle
 * ---------------------------------------------------------------------
 */

static void session_destroy(Session *s)
{
	if (!s) return;
	if (s->audio) {
		for (uint32_t i = 0; i < s->audio_track_count; i++) {
			AudioTrackState *a = &s->audio[i];
			if (a->codec_ctx) avcodec_free_context(&a->codec_ctx);
			if (a->frame)     av_frame_free(&a->frame);
			if (a->samples_fifo) free(a->samples_fifo);
		}
		free(s->audio);
	}
	if (s->video_frame)     av_frame_free(&s->video_frame);
	if (s->video_codec_ctx) avcodec_free_context(&s->video_codec_ctx);
	if (s->packet)          av_packet_free(&s->packet);
	if (s->fmt_ctx)         avformat_close_input(&s->fmt_ctx);
	if (s->avio) {
		av_free(s->avio->buffer);
		avio_context_free(&s->avio);
	}
	if (s->buf.data) free(s->buf.data);
	av_free(s);
}

/**
 * Open the file at `data` (size `size`). The caller is expected to
 * have already registered the codecs + demuxers needed via
 * `ffmpeg_register_codec` / `ffmpeg_register_demuxer`.
 *
 * Returns 0 on success, negative on failure.
 */
EXPORT int ffmpeg_open(uint8_t *data, size_t size)
{
	if (g_session) return -1;            /* already open */
	if (!data || !size) return -2;
	if (g_demuxer_count == 0) return -3; /* no demuxer registered */

	Session *s = (Session *)av_mallocz(sizeof(Session));
	if (!s) return -4;
	s->buf.data           = data;
	s->buf.size           = size;
	s->buf.pos            = 0;
	s->video_stream_index = -1;

	const int avio_buffer_size = 4096;
	void *avio_buffer = av_malloc(avio_buffer_size);
	if (!avio_buffer) goto fail;

	s->avio = avio_alloc_context(
		(unsigned char *)avio_buffer, avio_buffer_size,
		0, &s->buf,
		read_packet_cb, NULL, seek_cb);
	if (!s->avio) { av_free(avio_buffer); goto fail; }

	/* Find the matching demuxer by probing each registered one.
	 * We construct a fresh AVProbeData each iteration; the demuxer
	 * is the one whose `read_probe` returns the highest score. */
	const AVInputFormat *iformat = NULL;
	{
		AVProbeData pd = {
			.filename = "",
			.buf      = data,
			.buf_size = (int)(size < AVPROBE_PADDING_SIZE * 2 ? size
			                                                : AVPROBE_PADDING_SIZE * 2),
		};
		int best_score = 0;
		for (int i = 0; i < g_demuxer_count; i++) {
			const AVInputFormat *d = g_demuxers[i];
			if (!d->read_probe) {
				/* Demuxer has no probe — assume it's the format. */
				if (!iformat) iformat = d;
				continue;
			}
			int score = d->read_probe(&pd);
			if (score > best_score) {
				best_score = score;
				iformat    = d;
			}
		}
	}
	if (!iformat) goto fail;

	s->fmt_ctx = avformat_alloc_context();
	if (!s->fmt_ctx) goto fail;
	s->fmt_ctx->pb      = s->avio;
	s->fmt_ctx->iformat = iformat;

	int ret = avformat_open_input(&s->fmt_ctx, NULL, iformat, NULL);
	if (ret < 0) goto fail;

	ret = avformat_find_stream_info(s->fmt_ctx, NULL);
	if (ret < 0) goto fail;

	/* Pick the first video stream + count audio streams. */
	uint32_t audio_count = 0;
	for (unsigned i = 0; i < s->fmt_ctx->nb_streams; i++) {
		AVStream *st = s->fmt_ctx->streams[i];
		if (st->codecpar->codec_type == AVMEDIA_TYPE_VIDEO &&
		    s->video_stream_index < 0) {
			s->video_stream_index = (int)i;
		} else if (st->codecpar->codec_type == AVMEDIA_TYPE_AUDIO) {
			audio_count++;
		}
	}
	if (s->video_stream_index < 0) goto fail;

	/* Open the video decoder. */
	{
		AVStream *vst = s->fmt_ctx->streams[s->video_stream_index];
		const AVCodec *vc = find_codec(vst->codecpar->codec_id, AVMEDIA_TYPE_VIDEO);
		if (!vc) goto fail;

		s->video_codec_ctx = avcodec_alloc_context3(vc);
		if (!s->video_codec_ctx) goto fail;
		ret = avcodec_parameters_to_context(s->video_codec_ctx, vst->codecpar);
		if (ret < 0) goto fail;
		ret = avcodec_open2(s->video_codec_ctx, vc, NULL);
		if (ret < 0) goto fail;
		s->video_frame = av_frame_alloc();
		if (!s->video_frame) goto fail;
	}

	/* Open every audio decoder we can match. Tracks that have no
	 * registered codec are silently skipped — audio is best-effort
	 * (e.g. a bink2 file might play video while bink-audio ext
	 * isn't loaded). */
	if (audio_count > 0) {
		s->audio = (AudioTrackState *)calloc(audio_count, sizeof(AudioTrackState));
		if (!s->audio) goto fail;
		uint32_t aidx = 0;
		for (unsigned i = 0; i < s->fmt_ctx->nb_streams; i++) {
			AVStream *st = s->fmt_ctx->streams[i];
			if (st->codecpar->codec_type != AVMEDIA_TYPE_AUDIO) continue;
			const AVCodec *ac = find_codec(st->codecpar->codec_id, AVMEDIA_TYPE_AUDIO);
			if (!ac) continue; /* no decoder loaded for this stream */

			AudioTrackState *a = &s->audio[aidx];
			a->stream_index = (int)i;
			a->codec_ctx    = avcodec_alloc_context3(ac);
			if (!a->codec_ctx) goto fail;
			ret = avcodec_parameters_to_context(a->codec_ctx, st->codecpar);
			if (ret < 0) goto fail;
			ret = avcodec_open2(a->codec_ctx, ac, NULL);
			if (ret < 0) goto fail;
			a->frame       = av_frame_alloc();
			if (!a->frame) goto fail;
			a->channels    = (uint32_t)a->codec_ctx->ch_layout.nb_channels;
			a->sample_rate = (uint32_t)a->codec_ctx->sample_rate;
			aidx++;
		}
		s->audio_track_count = aidx;
	}

	s->packet = av_packet_alloc();
	if (!s->packet) goto fail;

	g_session = s;
	return 0;

fail:
	session_destroy(s);
	return -10;
}

EXPORT void ffmpeg_close(void)
{
	if (!g_session) return;
	Session *s = g_session;
	g_session  = NULL;
	session_destroy(s);
}

/*
 * ---------------------------------------------------------------------
 * Stream info accessors
 * ---------------------------------------------------------------------
 */

EXPORT uint32_t ffmpeg_width(void)
{
	return g_session && g_session->video_codec_ctx ? g_session->video_codec_ctx->width : 0;
}
EXPORT uint32_t ffmpeg_height(void)
{
	return g_session && g_session->video_codec_ctx ? g_session->video_codec_ctx->height : 0;
}
EXPORT uint32_t ffmpeg_frame_count(void)
{
	if (!g_session || !g_session->fmt_ctx) return 0;
	AVStream *st = g_session->fmt_ctx->streams[g_session->video_stream_index];
	return st->duration > 0 ? (uint32_t)st->duration : 0;
}
EXPORT uint32_t ffmpeg_fps_num(void)
{
	if (!g_session || !g_session->fmt_ctx) return 0;
	AVStream *st = g_session->fmt_ctx->streams[g_session->video_stream_index];
	return st->avg_frame_rate.num;
}
EXPORT uint32_t ffmpeg_fps_den(void)
{
	if (!g_session || !g_session->fmt_ctx) return 0;
	AVStream *st = g_session->fmt_ctx->streams[g_session->video_stream_index];
	return st->avg_frame_rate.den;
}
EXPORT uint32_t ffmpeg_pix_fmt(void)
{
	return g_session && g_session->video_codec_ctx
		? (uint32_t)g_session->video_codec_ctx->pix_fmt : 0;
}

EXPORT uint32_t ffmpeg_audio_track_count(void)
{
	return g_session ? g_session->audio_track_count : 0;
}
EXPORT uint32_t ffmpeg_audio_track_sample_rate(uint32_t i)
{
	if (!g_session || i >= g_session->audio_track_count) return 0;
	return g_session->audio[i].sample_rate;
}
EXPORT uint32_t ffmpeg_audio_track_channels(uint32_t i)
{
	if (!g_session || i >= g_session->audio_track_count) return 0;
	return g_session->audio[i].channels;
}

/*
 * ---------------------------------------------------------------------
 * Audio FIFO helpers
 * ---------------------------------------------------------------------
 */

static int audio_track_for_stream(int stream_index)
{
	if (!g_session) return -1;
	for (uint32_t i = 0; i < g_session->audio_track_count; i++) {
		if (g_session->audio[i].stream_index == stream_index) return (int)i;
	}
	return -1;
}

/* Normalise an AVFrame's samples to interleaved Float32 and append
 * to the track's FIFO. Returns 0 on success, -1 on OOM / unsupported
 * sample format. */
static int audio_fifo_append(AudioTrackState *a, AVFrame *fr)
{
	const uint32_t ch = a->channels;
	const uint32_t n  = (uint32_t)fr->nb_samples;
	if (n == 0) return 0;

	const uint32_t need = a->count_frames + n;
	if (need > a->capacity_frames) {
		uint32_t newcap = a->capacity_frames ? a->capacity_frames * 2 : 4096;
		while (newcap < need) newcap *= 2;
		float *nb = (float *)realloc(a->samples_fifo,
		                             (size_t)newcap * ch * sizeof(float));
		if (!nb) return -1;
		a->samples_fifo    = nb;
		a->capacity_frames = newcap;
	}

	float *dst = a->samples_fifo + (size_t)a->count_frames * ch;
	if (fr->format == AV_SAMPLE_FMT_FLT) {
		memcpy(dst, fr->data[0], (size_t)n * ch * sizeof(float));
	} else if (fr->format == AV_SAMPLE_FMT_FLTP) {
		for (uint32_t c = 0; c < ch; c++) {
			const float *src = (const float *)fr->data[c];
			for (uint32_t s = 0; s < n; s++) dst[s * ch + c] = src[s];
		}
	} else {
		/* Bink audio is FLTP. Other formats not handled yet. */
		return -1;
	}
	a->count_frames = need;
	return 0;
}

/* Forward an audio AVPacket to the matching audio codec and append
 * any produced samples. Caller owns `pkt` and unrefs after.
 *
 * Audio decode errors are non-fatal: a corrupt or unsupported audio
 * packet drops the packet (and flushes the codec state) but keeps
 * the overall decode going so the video stream can finish. The TS
 * layer can detect "too many audio failures in a row" via the
 * `failure_count` accessors and decide to disable the track from
 * its side — we intentionally don't bake codec-specific
 * recovery heuristics into the base wrapper.
 */
static void route_audio_packet(AVPacket *pkt)
{
	int t = audio_track_for_stream(pkt->stream_index);
	if (t < 0) return;  /* not a tracked audio stream — drop */
	AudioTrackState *a = &g_session->audio[t];

	int sr = avcodec_send_packet(a->codec_ctx, pkt);
	if (sr < 0 && sr != AVERROR(EAGAIN)) {
		avcodec_flush_buffers(a->codec_ctx);
		return;
	}
	for (;;) {
		int got = avcodec_receive_frame(a->codec_ctx, a->frame);
		if (got == AVERROR(EAGAIN) || got == AVERROR_EOF) break;
		if (got < 0) {
			avcodec_flush_buffers(a->codec_ctx);
			break;
		}
		if (audio_fifo_append(a, a->frame) < 0) {
			av_frame_unref(a->frame);
			break;
		}
		av_frame_unref(a->frame);
	}
}

static void drain_audio_decoders_eof(Session *s)
{
	for (uint32_t i = 0; i < s->audio_track_count; i++) {
		AudioTrackState *a = &s->audio[i];
		avcodec_send_packet(a->codec_ctx, NULL);
		for (;;) {
			int g2 = avcodec_receive_frame(a->codec_ctx, a->frame);
			if (g2 == AVERROR(EAGAIN) || g2 == AVERROR_EOF) break;
			if (g2 < 0) break;
			audio_fifo_append(a, a->frame);
			av_frame_unref(a->frame);
		}
	}
}

/*
 * ---------------------------------------------------------------------
 * Video decode
 * ---------------------------------------------------------------------
 *
 * Standard libavcodec receive/send loop. Audio packets we encounter
 * along the way are routed to their decoder; the JS side reads the
 * accumulated samples afterward via `ffmpeg_drain_audio`.
 *
 * Returns:
 *   1  - frame ready (plane accessors valid until next call)
 *   0  - end of stream
 *  <0  - error
 */
EXPORT int ffmpeg_decode_frame(void)
{
	if (!g_session) return -1;
	Session *s = g_session;

	while (1) {
		int ret = avcodec_receive_frame(s->video_codec_ctx, s->video_frame);
		if (ret == 0) goto frame_ready;
		if (ret == AVERROR_EOF) return 0;
		if (ret != AVERROR(EAGAIN)) return ret;

		/* Decoder needs more input. */
		ret = av_read_frame(s->fmt_ctx, s->packet);
		if (ret == AVERROR_EOF) {
			/* Flush video first; final audio tail is drained
			 * once video confirms EOF on its own EAGAIN cycle. */
			avcodec_send_packet(s->video_codec_ctx, NULL);
			drain_audio_decoders_eof(s);
			continue;
		}
		if (ret < 0) {
			av_packet_unref(s->packet);
			return ret;
		}

		if (s->packet->stream_index == s->video_stream_index) {
			ret = avcodec_send_packet(s->video_codec_ctx, s->packet);
			av_packet_unref(s->packet);
			if (ret < 0) return ret;
		} else {
			route_audio_packet(s->packet);
			av_packet_unref(s->packet);
		}
	}

frame_ready:
	s->width    = s->video_frame->width;
	s->height   = s->video_frame->height;
	s->y_stride = s->video_frame->linesize[0];
	s->u_stride = s->video_frame->linesize[1];
	s->v_stride = s->video_frame->linesize[2];
	s->y_data   = s->video_frame->data[0];
	s->u_data   = s->video_frame->data[1];
	s->v_data   = s->video_frame->data[2];
	s->frame_index++;
	return 1;
}

/*
 * Plane accessors. Pointers are valid until the next decode call.
 */
EXPORT uint32_t ffmpeg_frame_width(void)
{
	return g_session ? g_session->width : 0;
}
EXPORT uint32_t ffmpeg_frame_height(void)
{
	return g_session ? g_session->height : 0;
}
EXPORT uint32_t ffmpeg_frame_y_ptr(void)
{
	return g_session ? (uint32_t)(uintptr_t)g_session->y_data : 0;
}
EXPORT uint32_t ffmpeg_frame_u_ptr(void)
{
	return g_session ? (uint32_t)(uintptr_t)g_session->u_data : 0;
}
EXPORT uint32_t ffmpeg_frame_v_ptr(void)
{
	return g_session ? (uint32_t)(uintptr_t)g_session->v_data : 0;
}
EXPORT uint32_t ffmpeg_frame_y_stride(void)
{
	return g_session ? (uint32_t)g_session->y_stride : 0;
}
EXPORT uint32_t ffmpeg_frame_u_stride(void)
{
	return g_session ? (uint32_t)g_session->u_stride : 0;
}
EXPORT uint32_t ffmpeg_frame_v_stride(void)
{
	return g_session ? (uint32_t)g_session->v_stride : 0;
}

/*
 * ---------------------------------------------------------------------
 * Audio drain
 * ---------------------------------------------------------------------
 *
 * JS calls `ffmpeg_drain_audio(track)` whenever it wants the samples
 * accumulated so far. Returns the number of sample-frames (samples
 * per channel) available; the interleaved Float32 buffer is at
 * `ffmpeg_audio_drain_ptr(track)` and remains valid until the next
 * call to `ffmpeg_drain_audio(track)`. After draining, the FIFO's
 * count is reset to 0 (the backing buffer stays allocated).
 */
EXPORT uint32_t ffmpeg_drain_audio(uint32_t track_index)
{
	if (!g_session || track_index >= g_session->audio_track_count) return 0;
	AudioTrackState *a = &g_session->audio[track_index];
	uint32_t n = a->count_frames;
	a->count_frames = 0;
	return n;
}

EXPORT const float *ffmpeg_audio_drain_ptr(uint32_t track_index)
{
	if (!g_session || track_index >= g_session->audio_track_count) return NULL;
	return g_session->audio[track_index].samples_fifo;
}
