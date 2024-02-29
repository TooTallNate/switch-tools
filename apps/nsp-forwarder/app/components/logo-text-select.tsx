import { clsx } from 'clsx';
import React from 'react';
import * as Select from '@radix-ui/react-select';
import {
	CheckIcon,
	ChevronDownIcon,
	ChevronUpIcon,
} from '@radix-ui/react-icons';

export function LogoTextSelect(props: Select.SelectProps) {
	return (
		<Select.Root {...props}>
			<Select.Trigger
				className="SelectTrigger"
				aria-label="Text above logo"
				style={{ marginBottom: '8px' }}
			>
				<Select.Value placeholder="Text above logo…" />
				<Select.Icon className="SelectIcon">
					<ChevronDownIcon />
				</Select.Icon>
			</Select.Trigger>
			<Select.Portal>
				<Select.Content className="SelectContent">
					<Select.ScrollUpButton className="SelectScrollButton">
						<ChevronUpIcon />
					</Select.ScrollUpButton>
					<Select.Viewport className="SelectViewport">
						<Select.Group>
							<Select.Label className="SelectLabel">
								Text shown above logo
							</Select.Label>
							<SelectItem value="2">No text</SelectItem>
							<SelectItem value="0">"Licensed by"</SelectItem>
							<SelectItem value="1">"Distributed by"</SelectItem>
						</Select.Group>
					</Select.Viewport>
					<Select.ScrollDownButton className="SelectScrollButton">
						<ChevronDownIcon />
					</Select.ScrollDownButton>
				</Select.Content>
			</Select.Portal>
		</Select.Root>
	);
}

const SelectItem = React.forwardRef<HTMLDivElement, Select.SelectItemProps>(
	({ children, className, ...props }, forwardedRef) => {
		return (
			<Select.Item
				className={clsx('SelectItem', className)}
				{...props}
				ref={forwardedRef}
			>
				<Select.ItemText>{children}</Select.ItemText>
				<Select.ItemIndicator className="SelectItemIndicator">
					<CheckIcon />
				</Select.ItemIndicator>
			</Select.Item>
		);
	}
);
