import { InfoCircledIcon } from '@radix-ui/react-icons';
import * as Label from '@radix-ui/react-label';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useRef, useState } from 'react';

import { FileInput } from '~/components/file-input';

export interface InputProps
	extends Omit<React.ComponentPropsWithoutRef<'input'>, 'placeholder'> {
	label: React.ReactNode;
	tooltip: React.ReactNode;
	placeholder: React.ReactNode;
}

export const Input = ({
	name,
	label,
	type,
	tooltip,
	placeholder,
	children,
	...props
}: InputProps) => {
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const [fileName, setFileName] = useState<string | undefined>();

	const input =
		type === 'file' ? (
			<FileInput
				className="Input"
				name={name}
				{...props}
				onChange={(e) => {
					setFileName(e.currentTarget.files?.[0]?.name);
				}}
				ref={(ref) => {
					if (ref && fileInputRef.current !== ref) {
						setFileName(ref.files?.[0]?.name);
					}
				}}
			>
				<span>{fileName ?? placeholder}</span>
			</FileInput>
		) : (
			<input
				className="Input"
				type="text"
				name={name}
				id={name}
				placeholder={
					typeof placeholder === 'string' ? placeholder : undefined
				}
				{...props}
			/>
		);
	return (
		<div
			style={{
				width: '100%',
				display: 'flex',
				flexWrap: 'wrap',
				gap: 8,
				position: 'relative',
			}}
		>
			<Label.Root className="LabelRoot" htmlFor={name}>
				{label}
				{': '}
			</Label.Root>
			{input}
			<Tooltip.Provider>
				<Tooltip.Root>
					<Tooltip.Trigger asChild>
						<Label.Root className="LabelRoot" htmlFor={name}>
							<InfoCircledIcon />
						</Label.Root>
					</Tooltip.Trigger>
					<Tooltip.Portal>
						<Tooltip.Content
							className="TooltipContent"
							sideOffset={5}
						>
							{tooltip}
							<Tooltip.Arrow className="TooltipArrow" />
						</Tooltip.Content>
					</Tooltip.Portal>
				</Tooltip.Root>
			</Tooltip.Provider>
			{children}
		</div>
	);
};
