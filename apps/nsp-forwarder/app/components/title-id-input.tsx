import { FormEventHandler, useCallback, useEffect, useRef } from 'react';
import { Input } from './input';
import { Button } from '~/components/ui/button';
import { generateRandomID } from '~/lib/generate-id';

interface TitleIdInputProps {
	value: string;
	onInput: (v: string) => void;
}

export function TitleIdInput({ value, onInput }: TitleIdInputProps) {
	const titleIdInputRef = useRef<HTMLInputElement | null>(null);

	useEffect(() => {
		if (titleIdInputRef.current) {
			let { value } = titleIdInputRef.current;
			if (!value) {
				value = generateRandomID();
			}
			onInput(value);
		}
	}, [titleIdInputRef]);

	const handleInput: FormEventHandler<HTMLInputElement> = useCallback((e) => {
		onInput(e.currentTarget.value);
	}, []);

	return (
		<Input
			required
			name="id"
			label="Title ID"
			tooltip="The hexadecimal unique identifier for the title. This value is not shown on the Switch UI."
			placeholder="01abcdef12300000"
			minLength={16}
			maxLength={16}
			value={value}
			ref={titleIdInputRef}
			onInput={handleInput}
			style={{ fontFamily: 'monospace' }}
		>
			<Button
				variant="ghost"
				size="sm"
				title="Generate Random Title ID"
				tabIndex={-1}
				className="absolute right-6 select-none border-l border-input rounded-l-none h-9 text-xs px-2.5"
				onClick={(e) => {
					e.preventDefault();
					onInput(generateRandomID());
				}}
			>
				Random
			</Button>
		</Input>
	);
}
