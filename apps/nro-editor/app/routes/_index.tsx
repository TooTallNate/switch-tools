import { MouseEventHandler, useEffect, useRef, useState } from 'react';
import type { ChangeEventHandler } from 'react';
import type { LinksFunction } from '@vercel/remix';
import { Editor } from '~/components/editor';

import indexStyles from '~/styles/index.css?url';

export const links: LinksFunction = () => {
	return [{ rel: 'stylesheet', href: indexStyles }];
};

type Mode = 'initial' | 'editing';

export default function Index() {
	const [mode, setMode] = useState<Mode>('initial');
	const fileInputRef = useRef<HTMLInputElement>(null);
	const fileRef = useRef<File | null>(null);

	useEffect(() => {
		const fileInput = fileInputRef.current;
		if (fileInput) {
			const [file] = fileInput.files!;
			if (file) {
				setFile(file);
			} else {
				fileInput.focus();
			}
		}
	}, []);

	const setFile = (file: File) => {
		fileRef.current = file;
		setMode('editing');
	};

	const handleFileSelected: ChangeEventHandler<HTMLInputElement> = (e) => {
		const [file] = e.currentTarget.files!;
		if (file) {
			setFile(file);
		}
	};

	const handleReset: MouseEventHandler<HTMLButtonElement> = (e) => {
		e.preventDefault();
		fileRef.current = null;
		if (fileInputRef.current) {
			fileInputRef.current.value = '';
		}
		setMode('initial');
	};

	return (
		<div className="editor">
			<div className="intro">
				Edit or view the icon, metadata, and RomFS files of a Nintendo
				Switch homebrew application NRO file.
			</div>
			{mode === 'editing' && fileRef.current ? (
				<Editor nro={fileRef.current} onReset={handleReset} />
			) : (
				<label style={{ cursor: 'pointer', position: 'relative' }}>
					<input
						type="file"
						accept=".nro"
						ref={fileInputRef}
						onChange={handleFileSelected}
						style={{
							position: 'absolute',
							opacity: 0,
							width: '100%',
							height: '100%',
							top: 0,
							left: 0,
							cursor: 'inherit',
						}}
					/>
					<button className="active">
						<div className="cursor"></div>
						<span>Click to select NRO file...</span>
					</button>
				</label>
			)}
		</div>
	);
}
