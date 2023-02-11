import { InfoCircledIcon } from '@radix-ui/react-icons';
import * as Label from '@radix-ui/react-label';
import * as Tooltip from '@radix-ui/react-tooltip';

interface InputProps extends React.ComponentPropsWithoutRef<'input'> {
	name: string;
	label: React.ReactNode;
	tooltip: React.ReactNode;
}

export const Input = ({ name, label, tooltip, ...props }: InputProps) => {
	return (
		<div
			style={{
				display: 'flex',
				flexWrap: 'wrap',
				padding: '10px 0',
				gap: 8,
			}}
		>
			<Label.Root className="LabelRoot" htmlFor={name}>
				{label}
				{': '}
			</Label.Root>
			<input
				className="Input"
				type="text"
				name={name}
				id={name}
				{...props}
			/>
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
		</div>
	);
};
