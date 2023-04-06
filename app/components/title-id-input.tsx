import {
	FormEventHandler,
	useCallback,
	useEffect,
	useRef,
	useState,
} from 'react';
import { Input } from './input';
import { generateRandomID } from '~/lib/generate-id';

export function TitleIdInput() {
	const [value, setValue] = useState('');
	const titleIdInputRef = useRef<HTMLInputElement | null>(null);

	useEffect(() => {
		if (titleIdInputRef.current) {
			let { value } = titleIdInputRef.current;
			if (!value) {
				value = generateRandomID();
			}
			setValue(value);
		}
	}, [titleIdInputRef]);

	const handleInput: FormEventHandler<HTMLInputElement> = useCallback((e) => {
		setValue(e.currentTarget.value);
	}, []);

	return (
		<Input
			required
			name="id"
			label="Title ID"
			tooltip="The hexadecimal unique identifier for the title. This value is not shown on the Switch UI."
			placeholder="01abcdef12300000"
			value={value}
			ref={titleIdInputRef}
			onInput={handleInput}
		>
			<button
				className="IconButton"
				title="Generate Random Title ID"
				tabIndex={-1}
				style={{
					padding: '0 10px',
					fontSize: '13px',
					userSelect: 'none',
				}}
				onClick={(e) => {
					e.preventDefault();
					setValue(generateRandomID());
				}}
			>
				Random
			</button>
		</Input>
	);
}
