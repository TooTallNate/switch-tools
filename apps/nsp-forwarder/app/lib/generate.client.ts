import { NACP, VideoCapture } from '@tootallnate/nacp';
import { buildNsp } from '@tootallnate/hacbrewpack';

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
	// Build NACP
	const nacp = new NACP();
	nacp.id = id;
	nacp.title = title;
	nacp.author = publisher;
	nacp.version =
		typeof version === 'string' && version.length > 0 ? version : '1.0.0';
	nacp.startupUserAccount = 0;
	if (typeof startupUserAccount === 'boolean') {
		nacp.startupUserAccount = startupUserAccount ? 1 : 0;
	}
	nacp.screenshot = 0;
	if (typeof screenshot === 'boolean') {
		nacp.screenshot = screenshot ? 0 : 1;
	}
	nacp.videoCapture = VideoCapture.Disabled;
	if (typeof videoCapture === 'boolean') {
		nacp.videoCapture = videoCapture
			? VideoCapture.Automatic
			: VideoCapture.Disabled;
	}
	nacp.logoType = typeof logoType === 'number' ? logoType : 2;
	nacp.logoHandling = 0;

	// Build romfs paths
	const nextNroPath = `sdmc:${nroPath}`;
	let nextArgv = nextNroPath;
	if (typeof romPath === 'string') {
		nextArgv += ` "sdmc:${romPath}"`;
	}

	// Fetch all binary data in parallel
	const [keysText, imageData, logoData, startupMovieData, main, mainNpdm] =
		await Promise.all([
			keys.text(),
			image.arrayBuffer().then((b) => new Uint8Array(b)),
			logo?.arrayBuffer().then((b) => new Uint8Array(b)) ||
				fetchBinary('/template/logo/NintendoLogo.png'),
			startupMovie?.arrayBuffer().then((b) => new Uint8Array(b)) ||
				fetchBinary('/template/logo/StartupMovie.gif'),
			fetchBinary('/template/exefs/main'),
			fetchBinary('/template/exefs/main.npdm'),
		]);

	// Optional svcDebug patch
	if (enableSvcDebug) {
		mainNpdm[0x332] = mainNpdm[0x3f2] = 0x08;
	}

	// Build the NSP using the TypeScript hacbrewpack implementation
	const encoder = new TextEncoder();
	const result = await buildNsp({
		keys: keysText,
		titleId: id,
		plaintext: true,
		noPatchNacpLogo: true,
		exefs: new Map<string, Uint8Array>([
			['main', main],
			['main.npdm', mainNpdm],
		]),
		control: new Map<string, Uint8Array>([
			['control.nacp', new Uint8Array(nacp.buffer)],
			['icon_AmericanEnglish.dat', imageData],
		]),
		logo: new Map<string, Uint8Array>([
			['NintendoLogo.png', logoData],
			['StartupMovie.gif', startupMovieData],
		]),
		romfs: {
			nextArgv: new Blob([encoder.encode(nextArgv)]),
			nextNroPath: new Blob([encoder.encode(nextNroPath)]),
		},
	});

	return new File([result.nsp], result.filename, {
		type: 'application/octet-stream',
	});
}
