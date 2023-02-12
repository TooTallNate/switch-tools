import { Form } from '@remix-run/react';
import { LinksFunction } from '@remix-run/server-runtime';
import ReactCrop, { Crop, PercentCrop, PixelCrop } from 'react-image-crop';
import { useState, ChangeEventHandler, useEffect, useRef } from 'react';
import * as HoverCard from '@radix-ui/react-hover-card';

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
	crop: PixelCrop
) {
	const ctx = canvas.getContext('2d');
	if (!ctx) {
		throw new Error('No 2d context');
	}
	ctx.drawImage(
		image,
		crop.x,
		crop.y,
		crop.width,
		crop.height,
		0,
		0,
		canvas.width,
		canvas.height
	);
}

export default function Index() {
	const [imgSrc, setImgSrc] = useState<string>();
	const [crop, setCrop] = useState<Crop>();
	const [naturalCrop, setNaturalCrop] = useState<PixelCrop>({
		x: 0,
		y: 0,
		width: 0,
		height: 0,
		unit: 'px',
	});
	const [completedCrop, setCompletedCrop] = useState<PercentCrop>();
	const imgRef = useRef<HTMLImageElement | null>(null);
	const imgInputRef = useRef<HTMLInputElement | null>(null);
	const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);

	useEffect(() => {
		if (imgSrc) {
			// When a new image is selected, load it and set the initial crop
			const img = new Image();
			img.onload = () => {
				imgRef.current = img;
				const min = Math.min(img.naturalWidth, img.naturalHeight);
				const initialCrop: PercentCrop = {
					unit: '%',
					x: 0,
					y: 0,
					width: (min / img.naturalWidth) * 100,
					height: (min / img.naturalHeight) * 100,
				};
				setCrop(initialCrop);
				setCompletedCrop(initialCrop);
			};
			img.src = imgSrc;
		}
		return () => {
			if (imgSrc) {
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
			const newNaturalCrop: PixelCrop = {
				x: imgRef.current.naturalWidth * (completedCrop.x / 100),
				y: imgRef.current.naturalHeight * (completedCrop.y / 100),
				width:
					imgRef.current.naturalWidth * (completedCrop.width / 100),
				height:
					imgRef.current.naturalHeight * (completedCrop.height / 100),
				unit: 'px',
			};
			canvasPreview(
				imgRef.current,
				previewCanvasRef.current,
				newNaturalCrop
			);
			setNaturalCrop(newNaturalCrop);
		}
	}, [completedCrop]);

	const handleImageChange: ChangeEventHandler<HTMLInputElement> = (e) => {
		const file = e.currentTarget.files?.[0];
		handleImageFile(file);
	};

	const handleImageFile = (file?: File) => {
		if (!file) {
			setImgSrc(undefined);
			setCrop(undefined);
			setCompletedCrop(undefined);
			return;
		}
		const url = URL.createObjectURL(file);
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
						ref={(ref) => {
							if (ref && previewCanvasRef.current !== ref) {
								// Set width and height for HiDPI devices
								ref.width =
									ref.width * (window.devicePixelRatio || 1);
								ref.height =
									ref.height * (window.devicePixelRatio || 1);
								previewCanvasRef.current = ref;
							}
						}}
						style={{
							width: '256px',
							height: '256px',
							padding: 0,
							border: 'solid 1px transparent',
						}}
					/>
					<HoverCard.Root>
						<HoverCard.Trigger asChild>
							<input
								key="image-input"
								id="image"
								name="image"
								type="file"
								required
								onChange={handleImageChange}
								ref={(ref) => {
									if (ref && ref !== imgInputRef.current) {
										imgInputRef.current = ref;
										handleImageFile(ref?.files?.[0]);
									}
								}}
								style={{
									opacity: 0,
									position: 'absolute',
									top: 0,
									left: 0,
									width: '100%',
									height: '100%',
								}}
							/>
						</HoverCard.Trigger>
						<HoverCard.Portal>
							<HoverCard.Content
								className="HoverCardContent"
								sideOffset={5}
							>
								{imgSrc ? (
									<ReactCrop
										crop={crop}
										aspect={1}
										onChange={(_, crop) => setCrop(crop)}
										onComplete={(_, crop) =>
											setCompletedCrop(crop)
										}
									>
										<img
											ref={imgRef}
											src={imgSrc}
											style={{
												maxWidth: '400px',
												maxHeight: '400px',
											}}
										/>
									</ReactCrop>
								) : (
									'No image selected…'
								)}
								<HoverCard.Arrow className="HoverCardArrow" />
							</HoverCard.Content>
						</HoverCard.Portal>
					</HoverCard.Root>
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
				/>
				<button type="submit">Generate NSP</button>
			</Form>
		</>
	);
}
