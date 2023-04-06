import sharp from 'sharp';
import { join } from 'path';
import { once } from 'events';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import { mkdtemp, copy, writeFile, remove, readFile } from 'fs-extra';
import { redirect } from '@vercel/remix';

import { NACP } from '~/lib/nacp';
import { generateRandomID } from '~/lib/generate-id';
import { commitSession, getSession } from '~/session.server';

export interface LogChunk {
	type: 'stdout' | 'stderr';
	data: string;
}

export interface ErrorData {
	logs: LogChunk[];
	message: string;
	exitCode: number;
}

export async function generateNsp(request: Request) {
	const TEMPLATE_PATH = join(process.cwd(), 'template');
	const HACBREWPACK_PATH = join(
		process.cwd(),
		`hacbrewpack-${process.platform}`
	);

	const cwd = await mkdtemp(join(tmpdir(), `nsp-`));
	const logs: LogChunk[] = [];
	//console.log(cwd);
	try {
		const formData = await request.formData();
		//console.log(formData);

		const id = formData.get('id') || generateRandomID();
		if (typeof id !== 'string') {
			throw new Error('`id` is required');
		}
		const title = formData.get('title');
		if (typeof title !== 'string') {
			throw new Error('`title` is required');
		}
		const publisher = formData.get('publisher');
		if (typeof publisher !== 'string') {
			throw new Error('`publisher` is required');
		}
		const nroPath = formData.get('nroPath');
		if (typeof nroPath !== 'string') {
			throw new Error('`nroPath` is required');
		}
		const image = formData.get('image');
		if (!(image instanceof File)) {
			throw new Error('`image` is required');
		}
		const keys = formData.get('keys');
		if (!(keys instanceof File)) {
			throw new Error('`keys` is required');
		}

		const nacp = new NACP();
		nacp.id = id;
		nacp.title = title;
		nacp.author = publisher;

		const version = formData.get('version');
		nacp.version = typeof version === 'string' ? version : '1.0.0';

		const startupUserAccount = formData.get('startupUserAccount');
		nacp.startupUserAccount = startupUserAccount === 'checked' ? 1 : 0;

		nacp.screenshot = 1; // Enable screenshots by default
		const screenshot = formData.get('screenshot');
		if (typeof screenshot && screenshot !== 'checked') {
			nacp.screenshot = 0;
		}

		const logoType = formData.get('logoType');
		nacp.logoType = typeof logoType === 'string' ? Number(logoType) : 2;
		nacp.logoHandling = 0;

		const logo = formData.get('logo');
		const startupMovie = formData.get('startupMovie');
		const [imageBuffer, logoBuffer, startupMovieBuffer] = await Promise.all(
			[
				image.arrayBuffer(),
				logo instanceof File ? logo.arrayBuffer() : null,
				startupMovie instanceof File
					? startupMovie.arrayBuffer()
					: null,
				copy(TEMPLATE_PATH, cwd),
			]
		);

		let argv = `sdmc:${nroPath}`;

		const romPath = formData.get('romPath');
		if (typeof romPath === 'string') {
			argv += ` "sdmc:${romPath}"`;
		}

		await Promise.all([
			writeFile(
				join(cwd, 'keys.dat'),
				Buffer.from(await keys.arrayBuffer())
			),
			writeFile(
				join(cwd, 'control/control.nacp'),
				Buffer.from(nacp.buffer)
			),
			writeFile(join(cwd, 'romfs/nextNroPath'), `sdmc:${nroPath}`),
			writeFile(join(cwd, 'romfs/nextArgv'), argv),
			sharp(Buffer.from(imageBuffer))
				.jpeg({ quality: 100, chromaSubsampling: '4:2:0' })
				.resize(256, 256)
				.toFile(join(cwd, 'control/icon_AmericanEnglish.dat')),
			logoBuffer &&
				sharp(Buffer.from(logoBuffer))
					.png()
					.resize(160, 40)
					.toFile(join(cwd, 'logo/NintendoLogo.png')),
			startupMovieBuffer &&
				writeFile(
					join(cwd, 'logo/StartupMovie.gif'),
					Buffer.from(startupMovieBuffer)
				),
			//sharp(Buffer.from(startupMovieBuffer), { animated: true})
			//	.gif()
			//	.resize(256, 80)
			//	.toFile(join(cwd, 'logo/StartupMovie.gif')),
		]);

		const proc = spawn(
			HACBREWPACK_PATH,
			['--nopatchnacplogo', '--titleid', id],
			{ cwd, stdio: ['ignore', 'pipe', 'pipe'] }
		);
		proc.stdout.setEncoding('utf8');
		proc.stderr.setEncoding('utf8');
		proc.stdout.on('data', (data) => {
			logs.push({ type: 'stdout', data });
		});
		proc.stderr.on('data', (data) => {
			logs.push({ type: 'stderr', data });
		});
		await once(proc, 'close');
		if (typeof proc.exitCode === 'number' && proc.exitCode !== 0) {
			throw new SpawnError(proc.exitCode);
		}

		const output = await readFile(join(cwd, `hacbrewpack_nsp/${id}.nsp`));
		//await remove(cwd);

		return new Response(output, {
			headers: {
				'Content-Disposition': `attachment; filename="${title} [${id}].nsp"`,
			},
		});
	} catch (err: any) {
		console.log(err);
		console.log(logs);
		await remove(cwd);
		const session = await getSession(request.headers.get('Cookie'));
		const exitCode = err instanceof SpawnError ? err.exitCode : -1;
		const data: ErrorData = {
			logs,
			exitCode,
			message: err.message,
		};
		session.flash('error', data);
		return redirect('/error', {
			headers: {
				'Set-Cookie': await commitSession(session),
			},
		});
	}
}

class SpawnError extends Error {
	exitCode: number;

	constructor(exitCode: number) {
		super('Command failed');
		this.exitCode = exitCode;
	}
}
