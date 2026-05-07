/// <reference types="vite/client" />

// Allow importing arbitrary assets with `?url` to get a resolved URL string.
declare module '*?url' {
	const src: string;
	export default src;
}

// Specifically the aoTuV-603 codebook file from @tootallnate/wem-vorbis,
// which we fetch lazily on first Vorbis WEM decode.
declare module '@tootallnate/wem-vorbis/assets/packed_codebooks_aoTuV_603.bin?url' {
	const url: string;
	export default url;
}

// FMOD Vorbis setup-packet lookup table from @tootallnate/fsb5.
declare module '@tootallnate/fsb5/assets/fmod_vorbis_setup_packets.bin?url' {
	const url: string;
	export default url;
}
