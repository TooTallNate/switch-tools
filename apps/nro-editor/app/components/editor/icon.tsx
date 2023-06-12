export interface IconEditorProps {
	iconSrc: string;
}

export function IconEditor({ iconSrc }: IconEditorProps) {
	return <img src={iconSrc} style={{ width: '256px', height: '256px' }} />;
}
