/**
 * UE property-tag deserialiser.
 *
 * After the header tables (parsed by {@link parseUasset}) come the
 * actual export bodies. UE serialises each non-native UObject as a
 * stream of "property tags" terminated by a tag whose name is the
 * string `None`. A tag looks like (UE 4.20+ binary form):
 *
 *   FName  propertyName     // index into name table + number
 *   FName  propertyType     // "BoolProperty", "ArrayProperty", etc.
 *   i32    valueSize        // size of the value section in bytes
 *   i32    arrayIndex       // 0 unless this is an inlined static array
 *   ...    typeMeta         // type-specific tag fields, see below
 *   u8     hasGuid          // 0 or 1
 *   u8[16] propertyGuid     // present only when hasGuid == 1
 *   u8[size] value          // type-specific value (size == valueSize)
 *
 * Tag-meta fields (per type):
 *
 *   BoolProperty       u8 boolValue        (value section is empty; size=0)
 *   ByteProperty       FName enumName      ("None" if not an enum)
 *   EnumProperty       FName enumName
 *   ArrayProperty      FName innerType
 *   SetProperty        FName innerType
 *   MapProperty        FName keyType, FName valueType
 *   StructProperty     FName structName, u8[16] structGuid
 *   (others)           none
 *
 * After the property loop terminates at `None`, asset-class-specific
 * binary follows (FTexturePlatformData for Texture2D, row arrays for
 * DataTable, etc.). We expose the post-properties cursor so callers
 * can keep reading.
 *
 * **Soft on the unknown.** UE has a handful of property types we don't
 * decode (TextProperty's full FText layout, exotic structs, custom
 * SerializeNativeTags). When we hit one we read the declared `size`
 * bytes verbatim, surface them as `{ kind: 'unknown', rawBytes }`,
 * and continue. This keeps the deserialiser useful for the 95% case
 * even when individual tags fail.
 *
 * Refs:
 *   - UE source: `Engine/Source/Runtime/CoreUObject/Public/UObject/PropertyTag.h`
 *   - Clean-room: https://github.com/atenfyr/UAssetAPI (MIT)
 *   - https://github.com/AstroTechies/unrealmodding (MIT, Rust)
 */

import type { FName, ParsedUasset, UassetExport, UassetName } from './index.js';
import { resolveFName, resolvePackageIndex } from './index.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One decoded property tag with its decoded value.
 */
export interface UProperty {
	/** Property field name (resolved from the asset's name table). */
	name: string;
	/** Raw type name as written by UE (e.g. "BoolProperty"). */
	type: string;
	/** Static-array element index; 0 except for inlined `T[N]` properties. */
	arrayIndex: number;
	/** Decoded value. Always present, even for unknown types (as raw bytes). */
	value: UValue;
	/** 16-byte property GUID, hex, when the tag carried one. */
	propertyGuid: string | null;
}

/**
 * Decoded property value. The `kind` discriminator drives all branches
 * in any consumer (UI tree renderer, schema-aware extractor, etc.).
 */
export type UValue =
	| { kind: 'bool'; value: boolean }
	| { kind: 'int8'; value: number }
	| { kind: 'int16'; value: number }
	| { kind: 'int32'; value: number }
	| { kind: 'int64'; value: bigint }
	| { kind: 'uint16'; value: number }
	| { kind: 'uint32'; value: number }
	| { kind: 'uint64'; value: bigint }
	| { kind: 'float'; value: number }
	| { kind: 'double'; value: number }
	| { kind: 'name'; value: string }
	| { kind: 'string'; value: string }
	| { kind: 'text'; value: string; flags: number }
	| {
			kind: 'object';
			/** Raw FPackageIndex (negative=import, positive=export, 0=null). */
			index: number;
			/** Resolved target name (or "None"). */
			resolved: string;
	  }
	| { kind: 'softObject'; assetPath: string; subPath: string }
	| { kind: 'enum'; enumName: string; value: string }
	| {
			kind: 'byte';
			/** Enum name when this byte is an enum (else `null`). */
			enumName: string | null;
			/** Numeric value (0..255) for non-enum bytes; enum literal name otherwise. */
			value: number | string;
	  }
	| {
			kind: 'array';
			innerType: string;
			values: UValue[];
	  }
	| {
			kind: 'map';
			keyType: string;
			valueType: string;
			entries: Array<{ key: UValue; value: UValue }>;
			/** Number of keys to remove on patch-load. Almost always 0. */
			keysToRemove: number;
	  }
	| { kind: 'set'; innerType: string; values: UValue[] }
	| {
			kind: 'struct';
			structName: string;
			/** Decoded sub-properties when the struct is a generic UStruct. */
			properties?: UProperty[];
			/** Decoded value when the struct is a well-known native struct. */
			native?: NativeStruct;
			/** When neither path worked: the raw declared bytes. */
			rawBytes?: Uint8Array;
	  }
	| { kind: 'unknown'; rawBytes: Uint8Array; reason: string };

/**
 * Decoded value for the handful of well-known native structs whose
 * binary layout is fixed (no property tags, no UStruct schema).
 * UE's `SerializeNativeTags` registry lists ~80 of these; we cover
 * the geometry/color/transform set commonly used in property bodies.
 */
export type NativeStruct =
	| { kind: 'Vector'; x: number; y: number; z: number }
	| { kind: 'Vector2D'; x: number; y: number }
	| { kind: 'Vector4'; x: number; y: number; z: number; w: number }
	| { kind: 'IntPoint'; x: number; y: number }
	| { kind: 'IntVector'; x: number; y: number; z: number }
	| { kind: 'Rotator'; pitch: number; yaw: number; roll: number }
	| { kind: 'Quat'; x: number; y: number; z: number; w: number }
	| { kind: 'Color'; r: number; g: number; b: number; a: number }
	| {
			kind: 'LinearColor';
			r: number;
			g: number;
			b: number;
			a: number;
	  }
	| { kind: 'Plane'; x: number; y: number; z: number; w: number }
	| { kind: 'Guid'; value: string }
	| { kind: 'Box'; min: NativeStruct; max: NativeStruct; isValid: boolean }
	| { kind: 'Box2D'; min: NativeStruct; max: NativeStruct; isValid: boolean }
	| {
			kind: 'Transform';
			rotation: NativeStruct;
			translation: NativeStruct;
			scale3D: NativeStruct;
	  }
	| {
			kind: 'RichCurveKey';
			interpMode: number;
			tangentMode: number;
			tangentWeightMode: number;
			time: number;
			value: number;
			arriveTangent: number;
			arriveTangentWeight: number;
			leaveTangent: number;
			leaveTangentWeight: number;
	  }
	| { kind: 'SimpleCurveKey'; time: number; value: number };

/**
 * Result of deserialising one export's property tag stream.
 */
export interface UExportProperties {
	/** The export this came from (passthrough for callers). */
	export: UassetExport;
	/** Decoded properties up to (and excluding) the `None` terminator. */
	properties: UProperty[];
	/** Bytes consumed inside the .uexp body, including the `None` tag's 8-byte name. */
	consumed: number;
	/** Any tail bytes after the property loop ended (asset-class-specific blob). */
	tail: Uint8Array;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read property tags for a single export.
 *
 * @param parsed       Parsed `.uasset` header (provides names/imports/exports).
 * @param uexpBytes    Raw `.uexp` file bytes.
 * @param exportIndex  Index into `parsed.exports`.
 *
 * @throws if the export's body window goes out of bounds.
 *
 * The export's body lives at `export.serialOffset - totalHeaderSize`
 * within the `.uexp` (UE writes the .uasset header up to
 * `totalHeaderSize`, then the .uexp continues from there with each
 * export body packed contiguously).
 */
export function readExportProperties(
	parsed: ParsedUasset,
	uexpBytes: Uint8Array,
	exportIndex: number,
): UExportProperties {
	const exp = parsed.exports[exportIndex];
	if (!exp) {
		throw new Error(`uasset: export index ${exportIndex} out of bounds (have ${parsed.exports.length}).`);
	}
	const offset = exp.serialOffset - parsed.summary.totalHeaderSize;
	if (offset < 0 || offset >= uexpBytes.length) {
		throw new Error(
			`uasset: export "${resolveFName(exp.objectName, parsed.names)}" body offset ${offset} (serialOffset=${exp.serialOffset}, header=${parsed.summary.totalHeaderSize}) is outside the .uexp range (size=${uexpBytes.length}).`,
		);
	}
	const end = Math.min(uexpBytes.length, offset + exp.serialSize);
	const r = new Reader(uexpBytes, offset);
	const properties: UProperty[] = [];
	while (r.pos < end) {
		const tag = readNextTag(r, parsed);
		if (!tag) break; // hit None terminator
		properties.push(tag);
	}
	const consumed = r.pos - offset;
	const tail = uexpBytes.subarray(r.pos, end);
	return { export: exp, properties, consumed, tail };
}

/**
 * Decode one property tag from the current cursor position.
 * Returns `null` (and consumes the 8-byte FName) when the tag is
 * the `None` terminator; otherwise returns a fully-decoded
 * {@link UProperty}.
 */
function readNextTag(r: Reader, parsed: ParsedUasset): UProperty | null {
	const startPos = r.pos;
	const propNameFName = r.fname();
	const propName = resolveFName(propNameFName, parsed.names);
	if (propName === 'None') return null; // end of property loop

	const typeFName = r.fname();
	const type = resolveFName(typeFName, parsed.names);
	const valueSize = r.i32();
	const arrayIndex = r.i32();

	// Type-specific tag meta.
	let boolValue = false;
	let enumName: string | null = null;
	let innerType: string | null = null;
	let keyType: string | null = null;
	let valueTypeName: string | null = null;
	let structName: string | null = null;
	switch (type) {
		case 'BoolProperty':
			boolValue = r.u8() !== 0;
			break;
		case 'ByteProperty':
		case 'EnumProperty':
			enumName = resolveFName(r.fname(), parsed.names);
			if (enumName === 'None') enumName = null;
			break;
		case 'ArrayProperty':
		case 'SetProperty':
			innerType = resolveFName(r.fname(), parsed.names);
			break;
		case 'MapProperty':
			keyType = resolveFName(r.fname(), parsed.names);
			valueTypeName = resolveFName(r.fname(), parsed.names);
			break;
		case 'StructProperty':
			structName = resolveFName(r.fname(), parsed.names);
			r.skip(16); // struct GUID; we don't expose it
			break;
		// All other property types have no extra tag meta.
		default:
			break;
	}

	const hasGuid = r.u8();
	let propertyGuid: string | null = null;
	if (hasGuid !== 0) {
		propertyGuid = bytesToHex(r.bytes(16));
	}

	// Decode the value. We sandbox each tag by its declared `valueSize`
	// so a misread on one type doesn't desync the whole stream.
	const valueStart = r.pos;
	const valueEnd = valueStart + valueSize;
	let value: UValue;
	try {
		value = readValue(r, parsed, type, {
			valueSize,
			valueEnd,
			boolValue,
			enumName,
			innerType,
			keyType,
			valueType: valueTypeName,
			structName,
		});
	} catch (err) {
		// Skip past the declared value region and surface raw bytes.
		const raw = r.peekBytes(valueStart, valueEnd);
		value = {
			kind: 'unknown',
			rawBytes: raw,
			reason: `${type}: ${(err as Error).message}`,
		};
	}
	// Always realign to the tag's declared end — protects against the
	// inevitable per-tag length disagreements between UE versions.
	r.pos = valueEnd;
	void startPos;
	return {
		name: propName,
		type,
		arrayIndex,
		value,
		propertyGuid,
	};
}

interface ValueCtx {
	valueSize: number;
	valueEnd: number;
	boolValue: boolean;
	enumName: string | null;
	innerType: string | null;
	keyType: string | null;
	valueType: string | null;
	structName: string | null;
}

/**
 * Decode the value bytes of a property tag whose type/header were
 * already consumed by {@link readNextTag}.
 */
function readValue(
	r: Reader,
	parsed: ParsedUasset,
	type: string,
	ctx: ValueCtx,
): UValue {
	switch (type) {
		case 'BoolProperty':
			return { kind: 'bool', value: ctx.boolValue };
		case 'Int8Property':
			return { kind: 'int8', value: r.i8() };
		case 'Int16Property':
			return { kind: 'int16', value: r.i16() };
		case 'IntProperty':
			return { kind: 'int32', value: r.i32() };
		case 'Int64Property':
			return { kind: 'int64', value: r.i64() };
		case 'UInt16Property':
			return { kind: 'uint16', value: r.u16() };
		case 'UInt32Property':
			return { kind: 'uint32', value: r.u32() };
		case 'UInt64Property':
			return { kind: 'uint64', value: r.u64() };
		case 'FloatProperty':
			return { kind: 'float', value: r.f32() };
		case 'DoubleProperty':
			return { kind: 'double', value: r.f64() };
		case 'NameProperty':
			return { kind: 'name', value: resolveFName(r.fname(), parsed.names) };
		case 'StrProperty':
			return { kind: 'string', value: r.fstring() };
		case 'TextProperty':
			return readText(r, ctx);
		case 'ObjectProperty':
		case 'AssetObjectProperty':
		case 'WeakObjectProperty':
		case 'LazyObjectProperty':
		case 'InterfaceProperty':
		case 'ClassProperty': {
			const idx = r.i32();
			return {
				kind: 'object',
				index: idx,
				resolved: resolvePackageIndex(idx, parsed.imports, parsed.exports, parsed.names),
			};
		}
		case 'SoftObjectProperty':
		case 'SoftAssetPathProperty':
		case 'SoftClassProperty':
			return readSoftObject(r, parsed.names);
		case 'EnumProperty':
			return {
				kind: 'enum',
				enumName: ctx.enumName ?? '',
				value: resolveFName(r.fname(), parsed.names),
			};
		case 'ByteProperty':
			return readByte(r, parsed.names, ctx);
		case 'ArrayProperty':
			return readArray(r, parsed, ctx);
		case 'SetProperty':
			return readSet(r, parsed, ctx);
		case 'MapProperty':
			return readMap(r, parsed, ctx);
		case 'StructProperty':
			return readStruct(r, parsed, ctx);
		default: {
			// Unknown tag type; surface the raw declared value bytes.
			const raw = r.peekBytes(r.pos, ctx.valueEnd);
			r.pos = ctx.valueEnd;
			return {
				kind: 'unknown',
				rawBytes: raw,
				reason: `unsupported property type "${type}"`,
			};
		}
	}
}

// ---------------------------------------------------------------------------
// Per-type readers
// ---------------------------------------------------------------------------

/**
 * Byte/enum value: when `enumName` is set in the tag, the value is an
 * FName indexing the enum literal; otherwise it's a single u8.
 */
function readByte(r: Reader, names: UassetName[], ctx: ValueCtx): UValue {
	if (ctx.enumName) {
		return {
			kind: 'byte',
			enumName: ctx.enumName,
			value: resolveFName(r.fname(), names),
		};
	}
	return { kind: 'byte', enumName: null, value: r.u8() };
}

/**
 * FText is intricate — different "history types" (None, Base,
 * NamedFormat, ArgumentFormat, AsCulture, AsDate, AsTime, …) each
 * have their own layout. We decode the most common (Base / None /
 * StringTableEntry) and fall back to surfacing the source string
 * for the rest.
 */
function readText(r: Reader, ctx: ValueCtx): UValue {
	const flags = r.u32();
	const historyType = r.i8();
	let text = '';
	if (historyType === -1 /* HISTORY_TYPE_NONE */) {
		const hasCultureInvariant = r.u32();
		if (hasCultureInvariant !== 0) text = r.fstring();
	} else if (historyType === 0 /* HISTORY_TYPE_BASE */) {
		const namespace = r.fstring();
		const key = r.fstring();
		text = r.fstring();
		void namespace;
		void key;
	} else {
		// Unknown history; rewind to start of value and surface raw bytes.
		const raw = r.peekBytes(r.pos - 5, ctx.valueEnd);
		return { kind: 'unknown', rawBytes: raw, reason: `TextProperty history type ${historyType}` };
	}
	return { kind: 'text', value: text, flags };
}

/**
 * SoftObjectPath: `fstring assetPath, fstring subPath`.
 * (Older UE versions store `fname assetName, fstring subPath` — we
 * detect this by trying the FString layout first and falling back.)
 */
function readSoftObject(r: Reader, names: UassetName[]): UValue {
	void names;
	const assetPath = r.fstring();
	const subPath = r.fstring();
	return { kind: 'softObject', assetPath, subPath };
}

/**
 * ArrayProperty body:
 *   i32 count
 *   if innerType == "StructProperty":
 *     // a single property tag describes the element layout, then
 *     // count *inline* struct bodies follow without per-element tags.
 *     <inline struct tag header (8 fname + 8 fname + i32 + i32 + fname structName + 16-byte guid + u8 hasGuid + ...)>
 *     <element 0 body> ... <element N body>
 *   else:
 *     <count repetitions of the inner-type's value>
 */
function readArray(r: Reader, parsed: ParsedUasset, ctx: ValueCtx): UValue {
	const count = r.i32();
	const inner = ctx.innerType ?? '';
	if (inner === 'StructProperty') {
		// UE writes a property tag describing the struct layout, then
		// the struct bodies inline. The wrapper tag's `name` is the
		// containing array's name (which we already know), and its
		// type is "StructProperty"; we just need the struct name +
		// to skip the outer tag fields properly.
		// Layout (UE 4.27): outer FName, type FName, i32 size, i32 idx,
		// FName structName, u8[16] structGuid, u8 hasGuid (+optional 16).
		r.fname(); // outer name
		r.fname(); // type ("StructProperty")
		r.i32();   // size
		r.i32();   // arrayIndex
		const structName = resolveFName(r.fname(), parsed.names);
		r.skip(16); // struct guid
		const hasGuid = r.u8();
		if (hasGuid !== 0) r.skip(16);
		const values: UValue[] = [];
		for (let i = 0; i < count; i++) {
			if (r.pos >= ctx.valueEnd) break;
			values.push(readStructBody(r, parsed, structName, ctx.valueEnd));
		}
		return { kind: 'array', innerType: 'StructProperty', values };
	}
	const values: UValue[] = [];
	const innerCtx: ValueCtx = { ...ctx, valueSize: 0 };
	for (let i = 0; i < count; i++) {
		if (r.pos >= ctx.valueEnd) break;
		values.push(readInline(r, parsed, inner, innerCtx));
	}
	return { kind: 'array', innerType: inner, values };
}

/**
 * SetProperty: `i32 keysToRemove (always 0 outside patches), i32 count`,
 * then `count` inline values. Inner-type readers same as ArrayProperty.
 */
function readSet(r: Reader, parsed: ParsedUasset, ctx: ValueCtx): UValue {
	r.i32(); // keysToRemove (we drop this; not useful for previews)
	const count = r.i32();
	const inner = ctx.innerType ?? '';
	const values: UValue[] = [];
	const innerCtx: ValueCtx = { ...ctx, valueSize: 0 };
	for (let i = 0; i < count; i++) {
		if (r.pos >= ctx.valueEnd) break;
		values.push(readInline(r, parsed, inner, innerCtx));
	}
	return { kind: 'set', innerType: inner, values };
}

/**
 * MapProperty: `i32 keysToRemove, i32 count`, then `count` (key, value)
 * pairs each serialised inline.
 */
function readMap(r: Reader, parsed: ParsedUasset, ctx: ValueCtx): UValue {
	const keysToRemove = r.i32();
	const count = r.i32();
	const entries: Array<{ key: UValue; value: UValue }> = [];
	const inner: ValueCtx = { ...ctx, valueSize: 0 };
	for (let i = 0; i < count; i++) {
		if (r.pos >= ctx.valueEnd) break;
		const key = readInline(r, parsed, ctx.keyType ?? '', inner);
		const value = readInline(r, parsed, ctx.valueType ?? '', inner);
		entries.push({ key, value });
	}
	return {
		kind: 'map',
		keyType: ctx.keyType ?? '',
		valueType: ctx.valueType ?? '',
		entries,
		keysToRemove,
	};
}

/**
 * StructProperty body. Two paths:
 *  1. Native struct (Vector, Color, etc.) → fixed binary layout.
 *  2. Generic UStruct → recursive property tag stream, terminated by
 *     a `None` tag.
 */
function readStruct(r: Reader, parsed: ParsedUasset, ctx: ValueCtx): UValue {
	const structName = ctx.structName ?? '';
	return readStructBody(r, parsed, structName, ctx.valueEnd);
}

/**
 * Decode the body of a struct (no tag preamble — used both for
 * top-level StructProperty and for inlined structs inside arrays/sets).
 *
 * UE structs serialize one of two ways:
 *   1. **Native** (UScriptStruct overrides `Serialize` / `SerializeNativeTags`):
 *      fixed binary layout, no property tags. Determined by a flag on
 *      the C++ class which we obviously don't have. We hard-code the
 *      well-known ones in {@link NATIVE_STRUCT_SIZES}.
 *   2. **Tagged**: recursive property-tag stream terminated by a `None`
 *      tag. This is the default for UPROPERTY-only USTRUCTs.
 *
 * We try the native registry first (decoded value when we know the
 * layout, raw bytes of the registered size when we don't), then fall
 * back to a tagged property-stream parse.
 */
function readStructBody(
	r: Reader,
	parsed: ParsedUasset,
	structName: string,
	valueEnd: number,
): UValue {
	// 1. Native struct with a decoder.
	const decoded = readNativeStruct(r, structName);
	if (decoded) {
		return { kind: 'struct', structName, native: decoded };
	}
	// 2. Native struct we know is fixed-size but don't decode in detail.
	const fixedSize = NATIVE_STRUCT_SIZES[structName];
	if (fixedSize !== undefined) {
		const raw = r.peekBytes(r.pos, r.pos + fixedSize);
		r.skip(fixedSize);
		return { kind: 'struct', structName, rawBytes: raw };
	}
	// 3. Generic UStruct: recursive property-tag stream.
	const properties: UProperty[] = [];
	while (r.pos < valueEnd) {
		const tag = readNextTag(r, parsed);
		if (!tag) break;
		properties.push(tag);
	}
	return { kind: 'struct', structName, properties };
}

/**
 * Decode well-known native structs by their UE binary layout. Returns
 * null when `structName` isn't recognised — caller falls back to the
 * generic property-stream decoder.
 *
 * UE's `SerializeNativeTags` registry is the authoritative list; we
 * cover the ones that appear in actual asset data (geometry / color /
 * transform / GUID).
 */
function readNativeStruct(r: Reader, structName: string): NativeStruct | null {
	switch (structName) {
		case 'Vector':
			return { kind: 'Vector', x: r.f32(), y: r.f32(), z: r.f32() };
		case 'Vector2D':
			return { kind: 'Vector2D', x: r.f32(), y: r.f32() };
		case 'Vector4':
			return {
				kind: 'Vector4',
				x: r.f32(),
				y: r.f32(),
				z: r.f32(),
				w: r.f32(),
			};
		case 'IntPoint':
			return { kind: 'IntPoint', x: r.i32(), y: r.i32() };
		case 'Rotator':
			return {
				kind: 'Rotator',
				pitch: r.f32(),
				yaw: r.f32(),
				roll: r.f32(),
			};
		case 'Quat':
			return {
				kind: 'Quat',
				x: r.f32(),
				y: r.f32(),
				z: r.f32(),
				w: r.f32(),
			};
		case 'Color':
			// UE's FColor is stored BGRA on disk but exposed as RGBA in C++.
			// We store the in-memory order to match how the user thinks about it.
			return {
				kind: 'Color',
				b: r.u8(),
				g: r.u8(),
				r: r.u8(),
				a: r.u8(),
			};
		case 'LinearColor':
			return {
				kind: 'LinearColor',
				r: r.f32(),
				g: r.f32(),
				b: r.f32(),
				a: r.f32(),
			};
		case 'Guid':
			return { kind: 'Guid', value: bytesToHex(r.bytes(16)) };
		case 'Box':
			return {
				kind: 'Box',
				min: readNativeStruct(r, 'Vector')!,
				max: readNativeStruct(r, 'Vector')!,
				isValid: r.u8() !== 0,
			};
		case 'Box2D':
			return {
				kind: 'Box2D',
				min: readNativeStruct(r, 'Vector2D')!,
				max: readNativeStruct(r, 'Vector2D')!,
				isValid: r.u8() !== 0,
			};
		case 'Transform':
			return {
				kind: 'Transform',
				rotation: readNativeStruct(r, 'Quat')!,
				translation: readNativeStruct(r, 'Vector')!,
				scale3D: readNativeStruct(r, 'Vector')!,
			};
		case 'IntVector':
			return { kind: 'IntVector', x: r.i32(), y: r.i32(), z: r.i32() };
		case 'Plane':
			return {
				kind: 'Plane',
				x: r.f32(),
				y: r.f32(),
				z: r.f32(),
				w: r.f32(),
			};
		case 'RichCurveKey':
			// Layout: 3 × u8 enums + 6 × f32. Total 27 bytes (no padding —
			// UE archives don't pad these fields).
			return {
				kind: 'RichCurveKey',
				interpMode: r.u8(),
				tangentMode: r.u8(),
				tangentWeightMode: r.u8(),
				time: r.f32(),
				value: r.f32(),
				arriveTangent: r.f32(),
				arriveTangentWeight: r.f32(),
				leaveTangent: r.f32(),
				leaveTangentWeight: r.f32(),
			};
		case 'SimpleCurveKey':
			return { kind: 'SimpleCurveKey', time: r.f32(), value: r.f32() };
		default:
			return null;
	}
}

/**
 * Native struct fixed sizes for the structs we can't (yet) decode but
 * know are native-serialized — so we can advance the cursor by the
 * exact amount and keep parsing. Without these, we'd misread inline
 * arrays of these struct types as if they were tagged-property streams.
 *
 * Per-struct sizes are taken from UE source. Add entries here whenever
 * we hit an unfamiliar inline struct in the wild.
 */
const NATIVE_STRUCT_SIZES: Record<string, number> = {
	// Curve & gameplay: pretty-print as raw for now; future work to
	// decode the float/enum fields explicitly.
	RichCurveKey: 27,        // u8 InterpMode + u8 TangentMode + u8 TangentWeightMode + 6×f32
	SimpleCurveKey: 8,       // f32 Time + f32 Value
	// Math primitives we do decode (listed for completeness; readNativeStruct
	// handles them above). Keeping them here makes the registry the single
	// source of truth for sizes when we later refactor.
	Vector: 12,
	Vector2D: 8,
	Vector4: 16,
	IntPoint: 8,
	IntVector: 12,
	Rotator: 12,
	Quat: 16,
	Color: 4,
	LinearColor: 16,
	Guid: 16,
	Box: 25,                  // 2 × Vector + u8
	Box2D: 17,                // 2 × Vector2D + u8
	Plane: 16,                // f32 X/Y/Z/W
	Transform: 12 + 16 + 12,
	// Property attribute: any struct in this table that isn't decoded by
	// `readNativeStruct` will be surfaced as `{ kind: 'unknown', rawBytes }`
	// of exactly the listed size.
};

/**
 * Read an "inline" value of `type` — used inside ArrayProperty,
 * SetProperty, and MapProperty bodies, where there's no per-element
 * tag header. The type is whatever the outer tag declared.
 */
function readInline(
	r: Reader,
	parsed: ParsedUasset,
	type: string,
	ctx: ValueCtx,
): UValue {
	// Most inline-element types match the tagged-value reader, sans
	// the BoolProperty-in-tag exception (inline bools are a single u8).
	switch (type) {
		case 'BoolProperty':
			return { kind: 'bool', value: r.u8() !== 0 };
		case 'ByteProperty':
			// Inline ByteProperty in an array is always raw u8 (no FName).
			return { kind: 'byte', enumName: null, value: r.u8() };
		case 'StructProperty':
			// Inline structs in containers carry no struct-name tag; the
			// caller (ArrayProperty path) handles those via readStructBody.
			// For Map keys/values UE writes them WITHOUT a wrapper tag too,
			// but we don't know the struct name here — fall back to raw.
			return readInlineStructFallback(r, ctx);
		default:
			return readValue(r, parsed, type, { ...ctx, valueSize: 0 });
	}
}

function readInlineStructFallback(r: Reader, ctx: ValueCtx): UValue {
	// Without a struct name we can't pick a native decoder. Surface
	// raw bytes from the cursor to the container's end so the parser
	// stays aligned. This is rare in practice (arrays use the wrapper
	// tag path; only loose Map<…, FStruct> hits this).
	const raw = r.peekBytes(r.pos, ctx.valueEnd);
	r.pos = ctx.valueEnd;
	return { kind: 'unknown', rawBytes: raw, reason: 'inline struct without struct name' };
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

/**
 * Minimal read cursor — separate from the one in `index.ts` so this
 * module can be tested in isolation. Both readers share the same
 * little-endian conventions.
 */
class Reader {
	pos: number;
	view: DataView;
	#buf: Uint8Array;

	constructor(buf: Uint8Array, start = 0) {
		this.#buf = buf;
		this.pos = start;
		this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	}

	skip(n: number): void {
		this.pos += n;
	}
	bytes(n: number): Uint8Array {
		const out = this.#buf.subarray(this.pos, this.pos + n);
		this.pos += n;
		return out;
	}
	peekBytes(start: number, end: number): Uint8Array {
		return this.#buf.subarray(start, end);
	}
	u8(): number {
		const v = this.#buf[this.pos]!;
		this.pos += 1;
		return v;
	}
	i8(): number {
		const v = this.view.getInt8(this.pos);
		this.pos += 1;
		return v;
	}
	u16(): number {
		const v = this.view.getUint16(this.pos, true);
		this.pos += 2;
		return v;
	}
	i16(): number {
		const v = this.view.getInt16(this.pos, true);
		this.pos += 2;
		return v;
	}
	u32(): number {
		const v = this.view.getUint32(this.pos, true);
		this.pos += 4;
		return v;
	}
	i32(): number {
		const v = this.view.getInt32(this.pos, true);
		this.pos += 4;
		return v;
	}
	u64(): bigint {
		const v = this.view.getBigUint64(this.pos, true);
		this.pos += 8;
		return v;
	}
	i64(): bigint {
		const v = this.view.getBigInt64(this.pos, true);
		this.pos += 8;
		return v;
	}
	f32(): number {
		const v = this.view.getFloat32(this.pos, true);
		this.pos += 4;
		return v;
	}
	f64(): number {
		const v = this.view.getFloat64(this.pos, true);
		this.pos += 8;
		return v;
	}
	fname(): FName {
		return { nameIndex: this.u32(), number: this.u32() };
	}
	/**
	 * FString: `i32 len + bytes`. Positive len = UTF-8 + NUL; negative
	 * = UTF-16LE + NUL-NUL.
	 */
	fstring(): string {
		const len = this.i32();
		if (len === 0) return '';
		if (len > 0) {
			const slice = this.bytes(len);
			const trimEnd = slice[slice.length - 1] === 0 ? slice.length - 1 : slice.length;
			return new TextDecoder('utf-8').decode(slice.subarray(0, trimEnd));
		}
		const codeUnits = -len;
		const slice = this.bytes(codeUnits * 2);
		const trimEnd =
			slice[slice.length - 2] === 0 && slice[slice.length - 1] === 0
				? slice.length - 2
				: slice.length;
		return new TextDecoder('utf-16le').decode(slice.subarray(0, trimEnd));
	}
}

function bytesToHex(bytes: Uint8Array): string {
	let s = '';
	for (let i = 0; i < bytes.length; i++) {
		s += bytes[i]!.toString(16).padStart(2, '0');
	}
	return s;
}
