importScripts('./hacbrewpack.js');

const logs = [];
const hacbrewpackPromise = hacbrewpack({
	noInitialRun: true,
	print(v) {
		console.log(v);
		logs.push({ type: 'stdout', value: v });
	},
	printErr(v) {
		console.warn(v);
		logs.push({ type: 'stderr', value: v });
	},
});

onmessage = (e) => {
	logs.length = 0;
	hacbrewpackPromise.then((Module) => {
		const { FS } = Module;
		const {
			argv,
			keys,
			controlNacp,
			main,
			mainNpdm,
			image,
			logo,
			startupMovie,
			nextArgv,
			nextNroPath,
		} = e.data;

		FS.writeFile('/keys.dat', keys);

		FS.mkdir('/control');
		FS.writeFile('/control/control.nacp', controlNacp);
		FS.writeFile('/control/icon_AmericanEnglish.dat', image);

		FS.mkdir('/exefs');
		FS.writeFile('/exefs/main', main);
		FS.writeFile('/exefs/main.npdm', mainNpdm);

		FS.mkdir('/logo');
		FS.writeFile('/logo/NintendoLogo.png', logo);
		FS.writeFile('/logo/StartupMovie.gif', startupMovie);

		FS.mkdir('/romfs');
		FS.writeFile('/romfs/nextArgv', nextArgv);
		FS.writeFile('/romfs/nextNroPath', nextNroPath);

		const exitCode = Module.callMain(argv);

		let nsp;
		if (exitCode === 0) {
			try {
				const nspName = FS.readdir('/hacbrewpack_nsp').filter((n) =>
					n.endsWith('.nsp')
				)[0];

				const data = FS.readFile(`/hacbrewpack_nsp/${nspName}`);
				nsp = new File([data], nspName);
			} catch (err) {
				console.error('Failed to locate NSP file:', err.message);
			}
		}

		postMessage({
			exitCode,
			logs,
			nsp,
		});
	});
};
