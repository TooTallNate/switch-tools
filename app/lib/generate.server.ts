import { join } from 'path';
import { once } from 'events';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import { mkdtemp, copy, writeFile, remove, readFile } from 'fs-extra';

import { generateRandomID } from '~/lib/generate-id';

class BadRequest extends Response {
	constructor(message: string) {
		super(message, { status: 400 });
	}
}

export async function generateNsp(request: Request) {
	const TEMPLATE_PATH = join(process.cwd(), 'template');
	console.log();
	const HACBREWPACK_PATH = join(process.cwd(), 'hacbrewpack');

	const formData = await request.formData();
	const id = formData.get('id') || generateRandomID();
	const title = formData.get('title');
	const publisher = formData.get('publisher');
	const core = formData.get('core');
	const rom = formData.get('rom');
	const imageFile = formData.get('image');
	const keysFile = formData.get('keys');
	const cwd = await mkdtemp(join(tmpdir(), `nsp-`));
	try {
		if (typeof id !== 'string') {
			throw new BadRequest('expected "id" to be a string');
		}
		if (typeof title !== 'string') {
			throw new BadRequest('expected "title" to be a string');
		}
		if (typeof publisher !== 'string') {
			throw new BadRequest('expected "publisher" to be a string');
		}
		if (typeof core !== 'string') {
			throw new BadRequest('expected "core" to be a string');
		}
		if (typeof rom !== 'string') {
			throw new BadRequest('expected "rom" to be a string');
		}
		if (!imageFile || typeof imageFile === 'string') {
			throw new BadRequest('expected "image" to be a File');
		}
		if (!keysFile || typeof keysFile === 'string') {
			throw new BadRequest('expected "keys" to be a File');
		}

		await copy(TEMPLATE_PATH, cwd);

		await Promise.all([
			writeFile(
				join(cwd, 'keys.dat'),
				Buffer.from(await keysFile.arrayBuffer())
			),
			writeFile(join(cwd, 'romfs/nextNroPath'), `sdmc:${core}`),
			writeFile(
				join(cwd, 'romfs/nextArgv'),
				`sdmc:${core} "sdmc:${rom}"`
			),
			writeFile(
				join(cwd, 'control/icon_AmericanEnglish.dat'),
				Buffer.from(await imageFile.arrayBuffer())
			),
		]);

		const proc = spawn(
			HACBREWPACK_PATH,
			[
				'--titleid',
				id,
				'--titlename',
				title,
				'--titlepublisher',
				publisher,
			],
			{ cwd }
		);
		proc.stderr.pipe(process.stdout, { end: false });
		proc.stdout.pipe(process.stdout, { end: false });
		await once(proc, 'close');
		console.log('Exit code:', proc.exitCode);
		if (proc.exitCode !== 0) {
			throw new Response(`Got exit code ${proc.exitCode}`, {
				status: 500,
			});
		}

		const data = await readFile(join(cwd, `hacbrewpack_nsp/${id}.nsp`));
		await remove(cwd);

		return new Response(data, {
			headers: {
				'Content-Disposition': `attachment; filename="${title} [${id}].nsp"`,
			},
		});
	} finally {
		await remove(cwd);
	}
}
