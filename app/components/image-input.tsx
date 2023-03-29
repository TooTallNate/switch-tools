import { ChangeEventHandler, useEffect, useRef, useState } from 'react';
import ReactCrop, { Crop, PercentCrop, PixelCrop } from 'react-image-crop';
import * as HoverCard from '@radix-ui/react-hover-card';

import { FileInput, FileInputProps } from '~/components/file-input';

async function canvasPreview(
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

export interface ImageInputProps extends FileInputProps {
	placeholder?: React.ReactNode;
	onCrop?: (canvas: HTMLCanvasElement) => void;
}

export function ImageInput({ onCrop, placeholder, ...props }: ImageInputProps) {
	const [imgSrc, setImgSrc] = useState<string>();
	const [crop, setCrop] = useState<Crop>();
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
			console.log(completedCrop);
			const pixelCrop: PixelCrop = {
				x: imgRef.current.naturalWidth * (completedCrop.x / 100),
				y: imgRef.current.naturalHeight * (completedCrop.y / 100),
				width:
					imgRef.current.naturalWidth * (completedCrop.width / 100),
				height:
					imgRef.current.naturalHeight * (completedCrop.height / 100),
				unit: 'px',
			};
			canvasPreview(imgRef.current, previewCanvasRef.current, pixelCrop);
			onCrop?.(previewCanvasRef.current);
		}
	}, [completedCrop]);

	useEffect(() => {
		if (imgInputRef.current && previewCanvasRef.current) {
			const { width, height } =
				imgInputRef.current.getBoundingClientRect();
			// Set width and height for HiDPI devices
			const dpr = window.devicePixelRatio || 1;
			previewCanvasRef.current.width = width * dpr;
			previewCanvasRef.current.height = height * dpr;
		}
	}, [imgInputRef.current, previewCanvasRef.current]);

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

	const input = (
		<FileInput
			{...props}
			onChange={handleImageChange}
			ref={(ref) => {
				if (ref && ref !== imgInputRef.current) {
					imgInputRef.current = ref;
					handleImageFile(ref.files?.[0]);
				}
			}}
		>
			<div
				className="placeholder"
				style={{
					display: 'flex',
					justifyContent: 'center',
					alignItems: 'center',
					position: 'absolute',
					top: 0,
					left: 0,
					width: '100%',
					height: '100%',
					pointerEvents: 'none',
				}}
			>
				{placeholder}
			</div>
			<canvas
				ref={previewCanvasRef}
				style={{ pointerEvents: 'none', width: '100%', height: '100%' }}
			/>
		</FileInput>
	);

	return (
		<HoverCard.Root>
			<HoverCard.Trigger asChild>{input}</HoverCard.Trigger>
			<HoverCard.Portal>
				<HoverCard.Content className="HoverCardContent" sideOffset={5}>
					{imgSrc ? (
						<ReactCrop
							crop={crop}
							aspect={1}
							onChange={(_, crop) => setCrop(crop)}
							onComplete={(_, crop) => setCompletedCrop(crop)}
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
	);
}
