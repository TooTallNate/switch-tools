import {
	Select,
	SelectTrigger,
	SelectValue,
	SelectContent,
	SelectGroup,
	SelectLabel,
	SelectItem,
} from '~/components/ui/select';

interface LogoTextSelectProps {
	name?: string;
	value?: string;
	defaultValue?: string;
	onValueChange?: (value: string) => void;
}

export function LogoTextSelect(props: LogoTextSelectProps) {
	return (
		<Select {...props}>
			<SelectTrigger aria-label="Text above logo" className="mb-2">
				<SelectValue placeholder="Text above logo…" />
			</SelectTrigger>
			<SelectContent>
				<SelectGroup>
					<SelectLabel>Text shown above logo</SelectLabel>
					<SelectItem value="2">No text</SelectItem>
					<SelectItem value="0">"Licensed by"</SelectItem>
					<SelectItem value="1">"Distributed by"</SelectItem>
				</SelectGroup>
			</SelectContent>
		</Select>
	);
}
