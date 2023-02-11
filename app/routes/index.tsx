import { Form } from '@remix-run/react';
import { LinksFunction } from '@remix-run/server-runtime';
import ReactCrop, { Crop, PercentCrop } from 'react-image-crop';
import { useState, ChangeEventHandler, useEffect, useRef } from 'react';
import { InfoCircledIcon } from '@radix-ui/react-icons';
import * as Label from '@radix-ui/react-label';
import * as Tooltip from '@radix-ui/react-tooltip';

import { Input } from '~/components/input';

import cropStyles from 'react-image-crop/dist/ReactCrop.css';
import radixStyles from '@radix-ui/colors/whiteA.css';
import fontStyles from '~/styles/index.css';

export const links: LinksFunction = () => {
	return [
		{ rel: 'stylesheet', href: cropStyles },
		{ rel: 'stylesheet', href: radixStyles },
		{ rel: 'stylesheet', href: fontStyles },
	];
};

export async function canvasPreview(
	image: HTMLImageElement,
	canvas: HTMLCanvasElement,
	crop: PercentCrop
) {
	const ctx = canvas.getContext('2d');

	if (!ctx) {
		throw new Error('No 2d context');
	}

	const cropXS = image.naturalWidth * (crop.x / 100);
	const cropYS = image.naturalHeight * (crop.y / 100);
	const cropXW = image.naturalWidth * (crop.width / 100);
	const cropYH = image.naturalHeight * (crop.height / 100);
	ctx.drawImage(
		image,
		cropXS,
		cropYS,
		cropXW,
		cropYH,
		0,
		0,
		canvas.width,
		canvas.height
	);
}

export default function Index() {
	const [imgSrc, setImgSrc] = useState<string>();
	const [crop, setCrop] = useState<Crop>();
	const [completedCrop, setCompletedCrop] = useState<PercentCrop>();
	const imgRef = useRef<HTMLImageElement>(null);
	const previewCanvasRef = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		return () => {
			if (imgSrc) {
				console.log('revoking', imgSrc);
				URL.revokeObjectURL(imgSrc);
			}
		};
	}, [imgSrc]);

	useEffect(() => {
		if (
			completedCrop?.width &&
			completedCrop?.height &&
			imgRef.current &&
			previewCanvasRef.current
		) {
			canvasPreview(
				imgRef.current,
				previewCanvasRef.current,
				completedCrop
			);
		}
	}, [completedCrop]);

	const handleImageChange: ChangeEventHandler<HTMLInputElement> = (e) => {
		const file = e.currentTarget.files?.[0];
		if (!file) return;
		console.log(file);
		const url = URL.createObjectURL(file);
		console.log(url);
		setImgSrc(url);
	};

	return (
		<>
			<Form
				method="post"
				action="/generate"
				encType="multipart/form-data"
				reloadDocument
			>
				<label
					htmlFor="image"
					style={{ position: 'relative', lineHeight: 0 }}
				>
					<canvas
						className="Input"
						width={256}
						height={256}
						ref={previewCanvasRef}
						style={{ padding: 0, border: 'solid 1px transparent' }}
					/>
					<input
						id="image"
						name="image"
						type="file"
						required
						onChange={handleImageChange}
						style={{
							opacity: 0,
							position: 'absolute',
							top: 0,
							left: 0,
							width: '100%',
							height: '100%',
						}}
					/>
				</label>
				<Input
					name="title"
					required
					label="Title"
					tooltip="Name that will be shown on the Nintendo Switch home screen."
					placeholder="Super Mario World"
				/>
				<Input
					name="publisher"
					required
					label="Publisher"
					tooltip="Name of the publisher will be shown on the game's details page."
					placeholder="Nintendo"
				/>
				<Input
					name="core"
					required
					label="Core"
					tooltip="File path to the RetroArch core on the Nintendo Switch SD card."
					placeholder="/retroarch/cores/snes9x_libretro_libnx.nro"
				/>
				<Input
					name="rom"
					required
					label="ROM"
					tooltip="File path to the game ROM file on the Nintendo Switch SD card."
					placeholder="/ROMs/SNES/Super Mario World.smc"
				/>
				<Input
					name="keys"
					type="file"
					required
					label={<code>prod.keys</code>}
					tooltip={
						<>
							The <code>'prod.keys'</code> file generated on your
							Nintendo Switch by the{' '}
							<a
								target="blank"
								href="https://github.com/shchmue/Lockpick_RCM"
							>
								Lockpick_RCM
							</a>{' '}
							app.
						</>
					}
				/>
				<input type="submit" value="Generate NSP" />
			</Form>
			{imgSrc && (
				<ReactCrop
					crop={crop}
					aspect={1}
					onChange={(_, crop) => setCrop(crop)}
					onComplete={(_, crop) => setCompletedCrop(crop)}
				>
					<img ref={imgRef} src={imgSrc} width={300} />
				</ReactCrop>
			)}
		</>
	);
}
