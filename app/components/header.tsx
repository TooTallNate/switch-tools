export const Header = ({
	children,
	as: As,
}: {
	as: string;
	children: string;
}) => {
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
