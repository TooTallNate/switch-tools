import { Form } from '@remix-run/react';
import { useCallback, useRef, useState } from 'react';
import { LinksFunction } from '@vercel/remix';

import { Input } from '~/components/input';
import { ImageInput } from '~/components/image-input';
import { PresetsDropdown } from '~/components/presets-dropdown';
import { KeysPlaceholder, KeysTooltip } from '~/components/keys-input';

import cropStyles from 'react-image-crop/dist/ReactCrop.css';
import radixWhiteA from '@radix-ui/colors/whiteA.css';
import radixBlackA from '@radix-ui/colors/blackA.css';
import radixMauve from '@radix-ui/colors/mauveDark.css';
import radixViolet from '@radix-ui/colors/violetDark.css';
import fontStyles from '~/styles/index.css';

export const config = { runtime: 'edge' };

export const links: LinksFunction = () => {
	return [
		{ rel: 'stylesheet', href: cropStyles },
		{ rel: 'stylesheet', href: radixWhiteA },
		{ rel: 'stylesheet', href: radixBlackA },
		{ rel: 'stylesheet', href: radixMauve },
		{ rel: 'stylesheet', href: radixViolet },
		{ rel: 'stylesheet', href: fontStyles },
	];
};

export default function Index() {
	const [coreValue, setCoreValue] = useState('');
	const imageInputRef = useRef<HTMLInputElement | null>(null);

	const handleImageCrop: (c: HTMLCanvasElement) => void = useCallback(
		(canvas) => {
			canvas.toBlob((blob) => {
				if (blob && imageInputRef.current) {
					const file = new File([blob], 'image');
					const container = new DataTransfer();
					container.items.add(file);
					imageInputRef.current.files = container.files;
				}
			});
		},
		[imageInputRef]
	);

	return (
		<>
			<ImageInput
				className="Input image-input"
				placeholder="Click to select image…"
				cropAspectRatio={1}
				onCrop={handleImageCrop}
				style={{
					lineHeight: 0,
					margin: '1.4rem 0',
					width: '256px',
					height: '256px',
				}}
			/>
			<Form
				method="post"
				action="/generate"
				encType="multipart/form-data"
				reloadDocument
				style={{ width: '100%' }}
			>
				<Input
					name="title"
					required
					label="Title"
					tooltip="Name displyed on the Nintendo Switch home screen"
					placeholder="Super Mario World"
				/>
				<Input
					name="publisher"
					required
					label="Publisher"
					tooltip="Name of the publisher displayed on the game's details"
					placeholder="Nintendo"
				/>
				<Input
					name="core"
					required
					label="Core"
					tooltip="File path to the RetroArch core on the Nintendo Switch SD card"
					placeholder="/retroarch/cores/snes9x_libretro_libnx.nro"
					value={coreValue}
					onInput={(e) => {
						setCoreValue(e.currentTarget.value);
					}}
				>
					<PresetsDropdown
						value={coreValue}
						onSelect={(v) => setCoreValue(v)}
					/>
				</Input>
				<Input
					name="rom"
					label="ROM"
					tooltip="File path to the game ROM file on the Nintendo Switch SD card"
					placeholder="/ROMs/SNES/Super Mario World.smc"
				/>
				<Input
					name="keys"
					type="file"
					required
					label="Prod Keys"
					accept=".keys,.dat,text/*"
					tooltip={<KeysTooltip />}
					placeholder={<KeysPlaceholder />}
				/>
				<input
					type="file"
					name="image"
					ref={imageInputRef}
					required
					style={{
						opacity: 0,
						position: 'absolute',
						width: 0,
						height: 0,
					}}
				/>
				<button type="submit" className="Button">
					Generate NSP
				</button>
			</Form>
		</>
	);
}
