import ReactCrop, {
	centerCrop,
	Crop,
	makeAspectCrop,
	PercentCrop,
	PixelCrop,
} from 'react-image-crop';
import { Form } from '@remix-run/react';
import { useState, ChangeEventHandler, useEffect, useRef } from 'react';

import cropStyles from 'react-image-crop/dist/ReactCrop.css';

export function links() {
	return [{ rel: 'stylesheet', href: cropStyles }];
}

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
			<h1>NSP Forwarder Generator</h1>
			<div>
				<canvas
					width={256}
					height={256}
					ref={previewCanvasRef}
					style={{ border: 'solid 1px black' }}
				/>
			</div>
			<Form
				method="post"
				action="/generate"
				encType="multipart/form-data"
				reloadDocument
			>
				<ul>
					<li>
						Title: <input name="title" required />
					</li>
					<li>
						Publisher: <input name="publisher" required />
					</li>
					<li>
						Core: <input name="core" required />
					</li>
					<li>
						Rom: <input name="rom" required />
					</li>
					<li>
						Image:{' '}
						<input
							name="image"
							type="file"
							required
							onChange={handleImageChange}
						/>
					</li>
					<li>
						Keys: <input name="keys" type="file" required />
					</li>
					<li>
						<input type="submit" value="Generate NSP" />
					</li>
				</ul>
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
