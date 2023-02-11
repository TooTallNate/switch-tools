interface HeaderProps {
	as: React.ElementType;
	children: string;
}

export const Header = ({ as: As, children }: HeaderProps) => {
	return (
		<As>
			{children
				.split('')
				.map((char, i) =>
					char === ' ' ? char : <span key={i}>{char}</span>
				)}
		</As>
	);
};
