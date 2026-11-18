// ACL transform-track decompression for WebAssembly.
//
// acl_decompress(ptr) reads an ACL v2.0 `compressed_tracks` blob and
// returns a buffer laid out as: f32 duration, f32 sample rate,
// u32 samples, u32 tracks, then per sample, per track a qvvf
// (rotation xyzw, translation xyz + pad, scale xyz + pad: 12 floats).
// acl_result_size() gives that buffer's length; free it with acl_free.
#include <cstdint>
#include <cstdlib>
#include <cstring>

#include "acl/core/compressed_tracks.h"
#include "acl/decompression/decompress.h"

using namespace acl;

namespace {
struct writer final : public track_writer {
	float* out = nullptr;
	void RTM_SIMD_CALL write_rotation(uint32_t i, rtm::quatf_arg0 q) {
		rtm::quat_store(q, out + i * 12);
	}
	void RTM_SIMD_CALL write_translation(uint32_t i, rtm::vector4f_arg0 t) {
		rtm::vector_store(t, out + i * 12 + 4);
	}
	void RTM_SIMD_CALL write_scale(uint32_t i, rtm::vector4f_arg0 s) {
		rtm::vector_store(s, out + i * 12 + 8);
	}
};
uint32_t g_size = 0;
}

extern "C" {
__attribute__((export_name("acl_malloc"))) void* acl_malloc(uint32_t n) { return std::malloc(n); }
__attribute__((export_name("acl_free"))) void acl_free(void* p) { std::free(p); }
__attribute__((export_name("acl_result_size"))) uint32_t acl_result_size() { return g_size; }

__attribute__((export_name("acl_decompress"))) void* acl_decompress(const void* buffer) {
	g_size = 0;
	error_result err;
	const compressed_tracks* tracks = make_compressed_tracks(buffer, &err);
	if (tracks == nullptr || err.any()) return nullptr;
	if (tracks->get_track_type() != track_type8::qvvf) return nullptr;
	decompression_context<default_transform_decompression_settings> context;
	if (!context.initialize(*tracks)) return nullptr;
	const uint32_t n = tracks->get_num_tracks();
	const uint32_t samples = tracks->get_num_samples_per_track();
	const uint32_t size = 16 + samples * n * 48;
	uint8_t* out = static_cast<uint8_t*>(std::malloc(size));
	if (!out) return nullptr;
	const float duration = tracks->get_duration();
	const float rate = tracks->get_sample_rate();
	std::memcpy(out, &duration, 4);
	std::memcpy(out + 4, &rate, 4);
	std::memcpy(out + 8, &samples, 4);
	std::memcpy(out + 12, &n, 4);
	writer w;
	for (uint32_t s = 0; s < samples; s++) {
		const float t = rtm::scalar_min(float(s) / rate, duration);
		context.seek(t, sample_rounding_policy::nearest);
		w.out = reinterpret_cast<float*>(out + 16 + s * n * 48);
		context.decompress_tracks(w);
	}
	g_size = size;
	return out;
}
}
