import { NACP, VideoCapture } from '@tootallnate/nacp';

interface GenerateParams {
	id: string;
	keys: Blob;
	image: Blob;
	title: string;
	publisher: string;
	nroPath: string;

	version?: string;
	startupUserAccount?: boolean;
	screenshot?: boolean;
	videoCapture?: boolean;
	enableSvcDebug?: boolean;
	logoType?: number;
	romPath?: string;
	logo?: Blob;
	startupMovie?: Blob;
}

interface WorkerMessage {
	argv: string[];
	keys: Uint8Array;
	controlNacp: Uint8Array;
	main: Uint8Array;
	mainNpdm: Uint8Array;
	image: Uint8Array;
	logo: Uint8Array;
	startupMovie: Uint8Array;
	nextArgv: string;
	nextNroPath: string;
}

export interface LogChunk {
	type: 'stdout' | 'stderr';
	data: string;
}

interface WorkerResult {
	exitCode: number;
	logs: LogChunk[];
	nsp?: File;
}

async function fetchBinary(url: string): Promise<Uint8Array> {
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`Failed to fetch "${url}": ${await res.text()}`);
	}
	const buf = await res.arrayBuffer();
	return new Uint8Array(buf);
}

export async function generateNsp({
	id,
	keys,
	image,
	title,
	publisher,
	nroPath,

	version,
	startupUserAccount,
	screenshot,
	videoCapture,
	enableSvcDebug,
	logoType,
	romPath,
	logo,
	startupMovie,
}: GenerateParams): Promise<File> {
	const worker = new Worker('/generate-worker.js');
	const workerResultPromise = new Promise<WorkerResult>((resolve) => {
		worker.onmessage = (e) => {
			resolve(e.data);
			worker.terminate();
		};
	});

	const nacp = new NACP();
	nacp.id = id;
	nacp.title = title;
	nacp.author = publisher;
	nacp.version =
		typeof version === 'string' && version.length > 0 ? version : '1.0.0';
	nacp.startupUserAccount = 0; // Disable profile picker by default
	if (typeof startupUserAccount === 'boolean') {
		nacp.startupUserAccount = startupUserAccount ? 1 : 0;
	}
	nacp.screenshot = 0; // Enable screenshots by default
	if (typeof screenshot === 'boolean') {
		nacp.screenshot = screenshot ? 0 : 1;
	}
	nacp.videoCapture = VideoCapture.Disabled; // Disable video recording by default, since it allocates extra memory
	if (typeof videoCapture === 'boolean') {
		nacp.videoCapture = videoCapture
			? VideoCapture.Automatic
			: VideoCapture.Disabled;
	}
	nacp.logoType = typeof logoType === 'number' ? logoType : 2; // Show no text above logo by default
	nacp.logoHandling = 0;

	const nextNroPath = `sdmc:${nroPath}`;

	let nextArgv = nextNroPath;
	if (typeof romPath === 'string') {
		nextArgv += ` "sdmc:${romPath}"`;
	}

	const [keysData, imageData, logoData, startupMovieData, main, mainNpdm] =
		await Promise.all([
			keys.arrayBuffer().then((b) => new Uint8Array(b)),
			image.arrayBuffer().then((b) => new Uint8Array(b)),
			logo?.arrayBuffer().then((b) => new Uint8Array(b)) ||
				fetchBinary('/template/logo/NintendoLogo.png'),
			startupMovie?.arrayBuffer().then((b) => new Uint8Array(b)) ||
				fetchBinary('/template/logo/StartupMovie.gif'),
			fetchBinary('/template/exefs/main'),
			fetchBinary('/template/exefs/main.npdm'),
		]);

	if (enableSvcDebug) {
		// Patch the `main.npdm` to enable svcDebug on Atmosphère 1.8.0+
		// See: https://github.com/TooTallNate/switch-tools/pull/15
		mainNpdm[0x332] = mainNpdm[0x3f2] = 0x08;
	}

	const message: WorkerMessage = {
		argv: ['--nopatchnacplogo', '--titleid', id, '--plaintext'],
		keys: keysData,
		controlNacp: new Uint8Array(nacp.buffer),
		main,
		mainNpdm,
		image: imageData,
		logo: logoData,
		startupMovie: startupMovieData,
		nextArgv,
		nextNroPath,
	};

	worker.postMessage(message);

	const result = await workerResultPromise;

	if (result.exitCode === 0 && result.nsp) {
		return result.nsp;
	}

	throw new SpawnError(result.exitCode, result.logs);
}

class SpawnError extends Error {
	exitCode: number;
	logs: LogChunk[];

	constructor(exitCode: number, logs: LogChunk[]) {
		super('Failed to generate NSP file');
		this.exitCode = exitCode;
		this.logs = logs;
	}
}
