/**
 * Lazy-loaded YAML parser. We pull `js-yaml` in via a dynamic
 * import so the YAML grammar (~25 KB minified) only ships when
 * the user actually opens a YAML file. Cached on first call so
 * subsequent previews are synchronous after warmup.
 */

let yamlPromise: Promise<typeof import('js-yaml')> | null = null;

function loadYaml(): Promise<typeof import('js-yaml')> {
	if (!yamlPromise) yamlPromise = import('js-yaml');
	return yamlPromise;
}

/**
 * Parse a YAML 1.2 document string into its JS-shaped value.
 * Returns the same kind of shape `JSON.parse` would: objects /
 * arrays / strings / numbers / booleans / null. Multi-document
 * YAML files (`---`-separated) return an array of documents.
 *
 * Throws on parse error — callers should fall back to the raw
 * text view when this rejects.
 */
export async function parseYaml(text: string): Promise<unknown> {
	const yaml = await loadYaml();
	// `loadAll` for multi-doc support — `js-yaml` returns an array
	// even for single-document files when called this way, so we
	// unwrap when there's exactly one document so the inspector
	// shows the document contents rather than a one-element array.
	const docs: unknown[] = [];
	yaml.loadAll(text, (doc) => {
		docs.push(doc);
	});
	if (docs.length === 1) return docs[0];
	return docs;
}
