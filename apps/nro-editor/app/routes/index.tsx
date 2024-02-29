import { MouseEventHandler, useEffect, useRef, useState } from 'react';
import { FileInput } from '@tootallnate/react-file-input';
import type { ChangeEventHandler } from 'react';
import type { LinksFunction } from '@vercel/remix';
import { Editor } from '~/components/editor';

import indexStyles from '~/styles/index.css';

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
				<FileInput
					onChange={handleFileSelected}
					accept=".nro"
					ref={fileInputRef}
					style={{ cursor: 'pointer' }}
				>
					<button className="active">
						<div className="cursor"></div>
						<span>Click to select NRO file...</span>
					</button>
				</FileInput>
			)}
		</div>
	);
}
