import type { NACP } from '@tootallnate/nacp';

export interface MetadataEditorProps {
	nacp: NACP;
}

export function MetadataEditor({ nacp }: MetadataEditorProps) {
	return <>{nacp?.title}</>;
}
