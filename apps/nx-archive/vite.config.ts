import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
	plugins: [react(), tailwindcss()],
	// The media-scan worker (`src/lib/media/scan-worker.ts`) is an ES module:
	// the scanner pulls in code-split decoders (dynamic import) and `?url` WASM.
	worker: {
		format: 'es',
	},
	resolve: {
		alias: {
			'~': path.resolve(__dirname, './src'),
		},
	},
});
