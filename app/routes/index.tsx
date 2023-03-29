import { Form } from '@remix-run/react';
import { LinksFunction } from '@vercel/remix';

import { Input } from '~/components/input';
import { KeysPlaceholder, KeysTooltip } from '~/components/keys-input';

import cropStyles from 'react-image-crop/dist/ReactCrop.css';
import radixStyles from '@radix-ui/colors/whiteA.css';
import fontStyles from '~/styles/index.css';
import { ImageInput } from '~/components/image-input';
import { useCallback, useRef } from 'react';

export const config = { runtime: 'edge' };

export const links: LinksFunction = () => {
	return [
		{ rel: 'stylesheet', href: cropStyles },
		{ rel: 'stylesheet', href: radixStyles },
		{ rel: 'stylesheet', href: fontStyles },
	];
};

export default function Index() {
	const imageInputRef = useRef<HTMLInputElement | null>(null);

	const handleImageCrop: (c: HTMLCanvasElement) => void = useCallback(
		(canvas) => {
			console.log('crop', canvas);
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
				accept="image/*"
				placeholder="Click to select image…"
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
				/>
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
					accept="text/*"
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
				{/*
				<input
					type="hidden"
					name="image-crop-x"
					value={naturalCrop?.x}
				/>
				<input
					type="hidden"
					name="image-crop-y"
					value={naturalCrop?.y}
				/>
				<input
					type="hidden"
					name="image-crop-width"
					value={naturalCrop?.width}
				/>
				<input
					type="hidden"
					name="image-crop-height"
					value={naturalCrop?.height}
	/>*/}
				<button type="submit">Generate NSP</button>
			</Form>
		</>
	);
}
