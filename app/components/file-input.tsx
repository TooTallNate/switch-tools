import { forwardRef } from 'react';

export interface FileInputProps
	extends Omit<
		React.ComponentPropsWithoutRef<'input'>,
		'type' | 'placeholder'
	> {}

export const FileInput = forwardRef<HTMLInputElement, FileInputProps>(
	({ children, className, style, ...props }, ref) => {
		return (
			<label
				className={className}
				style={{ position: 'relative', ...style }}
			>
				<input
					ref={ref}
					type="file"
					{...props}
					style={{
						position: 'absolute',
						top: 0,
						left: 0,
						width: '100%',
						height: '100%',
						opacity: 0,
					}}
				/>
				{children}
			</label>
		);
	}
);
