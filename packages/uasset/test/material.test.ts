import { describe, expect, it } from 'vitest';
import {
	extractMaterialParentIndex,
	extractScalarParameters,
	extractTextureParameters,
	extractVectorParameters,
	type UProperty,
} from '../src/index.js';

/**
 * The material extractors take a decoded property list. We build those
 * by hand here, mirroring the exact shape `readExportProperties` would
 * produce for a real MaterialInstanceConstant. No commercial-game data.
 */

function makeMaterialPropertiesFixture(): UProperty[] {
	// Helper: a UStructProperty value with nested UProperty entries.
	const struct = (structName: string, properties: UProperty[]) => ({
		kind: 'struct' as const,
		structName,
		properties,
	});
	const name = (n: string, value: string): UProperty => ({
		name: n,
		type: 'NameProperty',
		arrayIndex: 0,
		value: { kind: 'name', value },
		propertyGuid: null,
	});
	const u8 = (n: string, value: number): UProperty => ({
		name: n,
		type: 'ByteProperty',
		arrayIndex: 0,
		value: { kind: 'byte', enumName: null, value },
		propertyGuid: null,
	});
	const i32Prop = (n: string, value: number): UProperty => ({
		name: n,
		type: 'IntProperty',
		arrayIndex: 0,
		value: { kind: 'int32', value },
		propertyGuid: null,
	});
	const objectProp = (n: string, idx: number, resolved: string): UProperty => ({
		name: n,
		type: 'ObjectProperty',
		arrayIndex: 0,
		value: { kind: 'object', index: idx, resolved },
		propertyGuid: null,
	});
	const floatProp = (n: string, value: number): UProperty => ({
		name: n,
		type: 'FloatProperty',
		arrayIndex: 0,
		value: { kind: 'float', value },
		propertyGuid: null,
	});

	// A ParameterInfo struct: { Name, Association, Index }.
	const parameterInfo = (paramName: string): UProperty => ({
		name: 'ParameterInfo',
		type: 'StructProperty',
		arrayIndex: 0,
		value: struct('MaterialParameterInfo', [
			name('Name', paramName),
			u8('Association', 0),
			i32Prop('Index', -1),
		]),
		propertyGuid: null,
	});

	return [
		objectProp('Parent', -2, 'M_BaseMaterial'),
		// TextureParameterValues = [
		//   { ParameterInfo.Name=BaseColor, ParameterValue→Texture (idx=-10) },
		//   { ParameterInfo.Name=Normal, ParameterValue→Texture (idx=-11) },
		// ]
		{
			name: 'TextureParameterValues',
			type: 'ArrayProperty',
			arrayIndex: 0,
			value: {
				kind: 'array',
				innerType: 'StructProperty',
				values: [
					struct('TextureParameterValue', [
						parameterInfo('BaseColor'),
						objectProp('ParameterValue', -10, 'T_Diffuse'),
					]),
					struct('TextureParameterValue', [
						parameterInfo('Normal'),
						objectProp('ParameterValue', -11, 'T_Normal'),
					]),
					// One entry whose ParameterValue is null (artist cleared the slot).
					struct('TextureParameterValue', [
						parameterInfo('Unused'),
						objectProp('ParameterValue', 0, 'None'),
					]),
				],
			},
			propertyGuid: null,
		},
		{
			name: 'ScalarParameterValues',
			type: 'ArrayProperty',
			arrayIndex: 0,
			value: {
				kind: 'array',
				innerType: 'StructProperty',
				values: [
					struct('ScalarParameterValue', [
						parameterInfo('Roughness'),
						floatProp('ParameterValue', 0.75),
					]),
				],
			},
			propertyGuid: null,
		},
		{
			name: 'VectorParameterValues',
			type: 'ArrayProperty',
			arrayIndex: 0,
			value: {
				kind: 'array',
				innerType: 'StructProperty',
				values: [
					struct('VectorParameterValue', [
						parameterInfo('Tint'),
						{
							name: 'ParameterValue',
							type: 'StructProperty',
							arrayIndex: 0,
							value: {
								kind: 'struct',
								structName: 'LinearColor',
								native: { kind: 'LinearColor', r: 1, g: 0.5, b: 0, a: 1 },
							},
							propertyGuid: null,
						},
					]),
				],
			},
			propertyGuid: null,
		},
	];
}

describe('extractTextureParameters', () => {
	it('returns one entry per resolved Texture slot, skipping null slots', () => {
		const params = extractTextureParameters(makeMaterialPropertiesFixture());
		expect(params).toEqual([
			{ parameterName: 'BaseColor', parameterValueIndex: -10 },
			{ parameterName: 'Normal', parameterValueIndex: -11 },
		]);
	});

	it('returns an empty array when no TextureParameterValues present', () => {
		expect(extractTextureParameters([])).toEqual([]);
	});
});

describe('extractScalarParameters', () => {
	it('returns one entry per float scalar', () => {
		const params = extractScalarParameters(makeMaterialPropertiesFixture());
		expect(params).toEqual([{ parameterName: 'Roughness', value: 0.75 }]);
	});
});

describe('extractVectorParameters', () => {
	it('returns LinearColor tuples per vector slot', () => {
		const params = extractVectorParameters(makeMaterialPropertiesFixture());
		expect(params).toEqual([
			{
				parameterName: 'Tint',
				value: { r: 1, g: 0.5, b: 0, a: 1 },
			},
		]);
	});
});

describe('extractMaterialParentIndex', () => {
	it('returns the Parent ObjectProperty index', () => {
		expect(extractMaterialParentIndex(makeMaterialPropertiesFixture())).toBe(-2);
	});

	it('returns 0 when no Parent property exists', () => {
		expect(extractMaterialParentIndex([])).toBe(0);
	});
});
