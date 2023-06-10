import { clsx } from 'clsx';
import {
	ChangeEventHandler,
	FocusEventHandler,
	forwardRef,
	useCallback,
	useRef,
	useState,
} from 'react';

export interface FileInputProps
	extends Omit<
		React.ComponentPropsWithoutRef<'input'>,
		'type' | 'placeholder'
	> {}

export const FileInput = forwardRef<HTMLInputElement, FileInputProps>(
	(
		{
			children,
			className,
			style,
			key,
			onFocus,
			onBlur,
			onChange,
			...props
		},
		fRef
	) => {
		const [focus, setFocus] = useState<boolean>(false);
		const [placeholder, setPlaceholder] = useState<boolean>(true);
		const inputRef = useRef<HTMLInputElement | null>(null);

		const handleFocus: FocusEventHandler<HTMLInputElement> = useCallback(
			(e) => {
				setFocus(true);
				onFocus?.(e);
			},
			[onFocus]
		);

		const handleBlur: FocusEventHandler<HTMLInputElement> = useCallback(
			(e) => {
				setFocus(false);
				onBlur?.(e);
			},
			[onBlur]
		);

		const handleChange: ChangeEventHandler<HTMLInputElement> = useCallback(
			(e) => {
				handleFiles(e.target.files);
				onChange?.(e);
			},
			[onChange]
		);

		const handleFiles = useCallback((files: FileList | null) => {
			setPlaceholder(!files?.length);
		}, []);

		return (
			<label
				key={key}
				className={clsx(className, { focus, placeholder })}
				style={{ position: 'relative', ...style }}
			>
				<input
					ref={(ref) => {
						if (ref && inputRef.current !== ref) {
							handleFiles(ref.files);
							if (typeof fRef === 'function') {
								fRef(ref);
							} else if (fRef) {
								fRef.current = ref;
							}
						}
					}}
					type="file"
					{...props}
					onFocus={handleFocus}
					onBlur={handleBlur}
					onChange={handleChange}
					style={{
						position: 'absolute',
						top: 0,
						left: 0,
						width: '100%',
						height: '100%',
						opacity: 0,
						cursor: 'inherit',
					}}
				/>
				{children}
			</label>
		);
	}
);
