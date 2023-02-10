import { useState, ChangeEventHandler } from 'react';
import { Form } from '@remix-run/react';

export default function Index() {
	const [imgSrc, setImgSrc] = useState();

	const handleImageChange: ChangeEventHandler<HTMLInputElement> = (e) => {
		console.log(e.target.files);
	};

	return (
		<>
			<h1>NSP Forwarder</h1>
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
		</>
	);
}
