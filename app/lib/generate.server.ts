import { z } from 'zod';
import { zfd } from 'zod-form-data';
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

const schema = zfd.formData({
	id: zfd.text(z.string().optional()),
	title: zfd.text(),
	publisher: zfd.text(),
	core: zfd.text(),
	rom: zfd.text(z.string().optional()),
	image: zfd.file(),
	keys: zfd.file(),
});

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
		const {
			id = generateRandomID(),
			title,
			publisher,
			core,
			rom,
			image,
			keys,
		} = schema.parse(await request.formData());
		const nacp = new NACP();
		nacp.id = id;
		nacp.title = title;
		nacp.author = publisher;
		nacp.version = '1.0';
		nacp.startupUserAccount = 0;
		nacp.logoHandling = 0;

		const [imageBuffer] = await Promise.all([
			image.arrayBuffer(),
			copy(TEMPLATE_PATH, cwd),
		]);

		let argv = `sdmc:${core}`;
		if (rom) {
			argv += ` "sdmc:${rom}"`;
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
			writeFile(join(cwd, 'romfs/nextNroPath'), `sdmc:${core}`),
			writeFile(join(cwd, 'romfs/nextArgv'), argv),
			sharp(Buffer.from(imageBuffer))
				.jpeg({ quality: 100, chromaSubsampling: '4:2:0' })
				.resize(256, 256)
				.toFile(join(cwd, 'control/icon_AmericanEnglish.dat')),
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

		const data = await readFile(join(cwd, `hacbrewpack_nsp/${id}.nsp`));
		await remove(cwd);

		return new Response(data, {
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
