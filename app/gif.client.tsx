import type { PixelCrop } from 'react-image-crop';
// @ts-expect-error
import gifsicle from 'gifsicle-wasm-browser';

const decoder = new TextDecoder('utf-8');

export interface GifsicleOptions {
	optimization?: number;
	lossy?: number;
	colors?: number;
	crop?: PixelCrop;
	resize?: { width: number; height: number };
	trim?: { start: number; end: number };
}

export async function cropAndScaleGIF(
	file: File,
	opts: GifsicleOptions = {}
): Promise<File> {
	const command: string[] = [];
	if (typeof opts.optimization === 'number') {
		command.push(`-O${opts.optimization}`);
	}
	if (typeof opts.lossy === 'number') {
		command.push(`--lossy=${opts.lossy}`);
	}
	if (typeof opts.colors === 'number') {
		command.push(`--colors ${opts.colors}`);
	}
	if (opts.crop) {
		const cropX = Math.round(opts.crop.x);
		const cropY = Math.round(opts.crop.y);
		const cropWidth = Math.round(opts.crop.width);
		const cropHeight = Math.round(opts.crop.height);
		command.push(`--crop`, `${cropX},${cropY}+${cropWidth}x${cropHeight}`);
	}
	if (opts.resize) {
		command.push('--resize', `${opts.resize.width}x${opts.resize.height}`);
	}
	command.push('input.gif');
	if (opts.trim) {
		command.push(`#${opts.trim.start - 1}-${opts.trim.end - 1}`);
	}
	command.push('-o', '/out/out.gif');
	const out = await gifsicle.run({
		input: [
			{
				file,
				name: 'input.gif',
			},
		],
		command: [command.join(' ')],
	});
	return out[0];
}

export async function getInfo(file: File): Promise<string> {
	const arr = await gifsicle.run({
		input: [
			{
				file,
				name: '1.gif',
			},
		],
		command: ['--info 1.gif -o /out/out.txt'],
	});
	const out: File = arr[0];
	const data = decoder.decode(await out.arrayBuffer());
	return data;
}
