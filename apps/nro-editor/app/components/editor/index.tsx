import { clsx } from 'clsx';
import { MouseEventHandler, useEffect, useRef, useState } from 'react';
import { extractIcon, extractNACP } from '@tootallnate/nro';
import { IconEditor } from './icon';
import type { NACP } from '@tootallnate/nacp';
import { MetadataEditor } from './metadata';
import { DownloadIcon } from '@radix-ui/react-icons';

export interface EditorProps {
	nro: File;
	onReset?: MouseEventHandler<HTMLButtonElement>;
}

enum Section {
	Icon,
	Metadata,
	RomFS,
}

const sectionKeys = Object.keys(Section).filter((v) =>
	isNaN(Number(v))
) as (keyof typeof Section)[];

export function Editor(props: EditorProps) {
	const { nro } = props;
	const [iconSrc, setIconSrc] = useState('');
	const [nacp, setNacp] = useState<NACP | null>(null);
	const [activeSection, setActiveSection] = useState(Section.Icon);

	useEffect(() => {
		extractIcon(nro).then((blob) => {
			const url = URL.createObjectURL(blob);
			setIconSrc(url);
		});
		extractNACP(nro).then((nacp) => {
			console.log(nacp);
			setNacp(nacp);
		});
	}, [nro]);

	const handleSidebarClick: MouseEventHandler<HTMLButtonElement> = (e) => {
		e.preventDefault();
		const button = e.currentTarget;
		const section = Array.from(button.parentElement!.children).indexOf(
			button
		);
		setActiveSection(section);
	};

	let content: JSX.Element;
	if (activeSection === Section.Icon) {
		content = <IconEditor iconSrc={iconSrc} />;
	} else if (activeSection === Section.Metadata) {
		content = <MetadataEditor nacp={nacp!} />;
	} else {
		// RomFS
		content = <>romfs</>;
	}

	return (
		<div className="editor-main">
			<div className="editor-inner">
				<div className="editor-sidebar">
					{sectionKeys.map((section, i) => (
						<button
							className={clsx({ active: activeSection === i })}
							onClick={handleSidebarClick}
							key={section}
						>
							<div className="cursor" />
							{section}
						</button>
					))}
				</div>
				<div className="editor-content">
					{content}
					{/*<IconEditor src={iconSrc} />*/}
				</div>
			</div>
			<div className="editor-save">
				<button onClick={props.onReset}>
					<div className="cursor" />
					Reset
				</button>
				<button>
					<div className="cursor" />
					Save Modified NRO&nbsp;
					<DownloadIcon width="1em" height="1em" />
				</button>
			</div>
		</div>
	);
}
