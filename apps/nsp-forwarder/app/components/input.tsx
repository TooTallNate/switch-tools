import { Info } from 'lucide-react';
import { Label } from '~/components/ui/label';
import { Input as ShadcnInput } from '~/components/ui/input';
import {
	Tooltip,
	TooltipTrigger,
	TooltipContent,
} from '~/components/ui/tooltip';
import { forwardRef, useRef, useState } from 'react';
import { cn } from '~/lib/utils';

export interface InputProps
	extends Omit<React.ComponentPropsWithoutRef<'input'>, 'placeholder'> {
	label: React.ReactNode;
	tooltip: React.ReactNode;
	placeholder: React.ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
	({ name, label, type, tooltip, placeholder, children, ...props }, fRef) => {
		const inputRef = useRef<HTMLInputElement | null>(null);
		const [fileName, setFileName] = useState<string | undefined>();

		const input =
			type === 'file' ? (
				<label
					className={cn(
						'flex h-9 min-w-0 flex-1 cursor-pointer items-center overflow-hidden rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors',
						'dark:bg-input/30',
						!fileName && 'text-muted-foreground'
					)}
				>
					<input
						type="file"
						className="hidden"
						name={name}
						{...props}
						onChange={(e) => {
							setFileName(e.currentTarget.files?.[0]?.name);
							props.onChange?.(e);
						}}
						ref={(ref) => {
							if (ref && inputRef.current !== ref) {
								setFileName(ref.files?.[0]?.name);
								if (typeof fRef === 'function') {
									fRef(ref);
								} else if (fRef) {
									fRef.current = ref;
								}
							}
						}}
					/>
					<span>{fileName ?? placeholder}</span>
				</label>
			) : (
				<ShadcnInput
					className="min-w-0 flex-1"
					type="text"
					name={name}
					id={name}
					size={1}
					placeholder={
						typeof placeholder === 'string'
							? placeholder
							: undefined
					}
					ref={(ref) => {
						if (ref && inputRef.current !== ref) {
							if (typeof fRef === 'function') {
								fRef(ref);
							} else if (fRef) {
								fRef.current = ref;
							}
						}
					}}
					{...props}
				/>
			);
		return (
			<div className="relative flex w-full items-center gap-2">
				<Label htmlFor={name} className="shrink-0 whitespace-nowrap">
					{label}
					{': '}
				</Label>
				{input}
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							className="shrink-0 text-muted-foreground hover:text-foreground"
						>
							<Info className="size-4" />
						</button>
					</TooltipTrigger>
					<TooltipContent sideOffset={5}>{tooltip}</TooltipContent>
				</Tooltip>
				{children}
			</div>
		);
	}
);
