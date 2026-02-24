/**
 * RSA-2048-PSS signing for NCA headers using Web Crypto.
 *
 * Uses the same hardcoded RSA-2048 keypair from hacbrewpack/rsa_keys.h
 * to sign NCA headers and patch NPDM ACID public keys.
 */

/**
 * The self-generated RSA-2048 private key in PEM format.
 * From hacbrewpack/rsa_keys.h.
 */
const RSA_PRIVATE_KEY_PEM = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEAvVRzt+8mE7oE4RkmSh3ws4CGlBj7uhHkfwCpPFsn4TNVdLRo
YYY17jQYWTtcOYPMcHxwUpgJyspGN8QGXEkJqY8jILv2eO0jBGtg7Br2afUBp6/x
BOMT2RlYVX6H4a1UA19Hzmcn+T1hdDwS6oBYpi8rJSm0+q+yB34dueNkVsk4eKbj
CNNKFi+XgyNBi41d57SPCrkcm/9tkagRorE8vLcFPcXcYOjdXH3L4XTXq7sxxytA
I66erfSc4XunkoLifcbfMOB3gjGCoQs6GfaiAU3TwxewQ7hdoqvj5Gm9VyHqzeDF
5mUTlmed2I6m4ELxbV1b0lUguR5ZEzwXwiVWxwIDAQABAoIBADvLYkijFOmCBGx7
HualkhF+9AHt6gKYCAw8Tzaqq2uqZMDZAWZblsjGVzJHVxcrEvQruOW88srDG24d
UMzwnEaa2ENMWclTS43nw9KNqWlJYd5t6LbcaLZWFNnbflq9/RybiPgdCDjlM9Qb
7PV214iUuRGhnHDX8GgBYq4ErPnjQ7+Gv1ducpMYjZencLWCl4fFX86U0/MU0+Qf
jKGegQTnk52aaeScbDOjjx5h+m0hkDNSfsmXTlvJt2c8wy/Yx+leVgCPjMC1nbft
Ob1TlpjuEAKBOGt4+DkWwVmIlxilmx9wCTZnwvPKd7A0e0FGsdHnQienPrMqlgbl
JPYwJuECgYEA6yLZHTfX3ebpzcdQQqmuHZtbOcs+EGRy24gAzd+9vCGKf0VtKSl9
3oA3XBOe2C2TgSgbWFZ7v/2efWRjgwJta0BQlpkzkh6NUQa2LI2M3zgZwHCZ7Ihr
skG73qZsMHOOv7VQz/wDp6AZNasfz21Mcyh4uFzpkb3NKLXqsJ9LeG8CgYEAziEb
yBCuhCKq7YZt/cHlbCbi7HbCYbub0isOCUtV0qPsX+kVZdPS+oGLPq1905JKdAe9
O+4SltCw6qn9RgYnCCVQ47SGHg7KO8Z5vdcNUiDvsQ+jNFlmM5QBuf1UV/Y+DV/Q
fZdA06OeYxkfPuBMtjdS9qMKwm3OsCkiQasWQykCgYAqALieAoq6JfSgALmyntLu
kQDzyv2UOg1Wb+4M2KnxAGDYKVO9pZ7Jb0f0V8DpRwLxcHOqDRDgE/MK3TL1hSp8
nSmILWfL8081KSjDvqlqeoAHI1YrrZbnadyggkQTR6E5V69O5+rTN8MpFh+Bkzmz
3IfsDxTeJvSOECkTUfFOWwKBgQDG/id3yMLxRRaGH5TnuNvmwNOpPC0DdL5E8tOm
HVhI9X8oSDgkCY5Pz+fBJnOmYEAIK8B/rqG7ftSMdnbPtvjPYFbqvEgNlHGfq0e0
AXwWoT1ETbhcvUFw4Z2ZE/rswAe/mZQI6o/mwLoTKRmE9byY3Gf3OgcVFDTI060C
gEwJoQKBgHpOmtGum3JuLpPc+PTXZOe29tdWndkFWktjPoow60d+NO2jpTFuEpmW
XRW35vXI8PqMCmHOQ8YU59aMN9juAnsJmPUxbAW5fZfvVwWUo0cTOenfT6syrEYO
n5NEG+mY4WZaOFRNiZu8+4aJI1yycXMyA22iKcU8+nN/sMAJs3Nx
-----END RSA PRIVATE KEY-----`;

/**
 * The self-generated RSA-2048 public key modulus (256 bytes).
 * This is patched into the NPDM ACID section so the console
 * accepts our signature.
 * From hacbrewpack/rsa_keys.h.
 */
// prettier-ignore
export const RSA_PUBLIC_KEY_MODULUS = new Uint8Array([
	0xbd, 0x54, 0x73, 0xb7, 0xef, 0x26, 0x13, 0xba, 0x04, 0xe1, 0x19, 0x26, 0x4a, 0x1d,
	0xf0, 0xb3, 0x80, 0x86, 0x94, 0x18, 0xfb, 0xba, 0x11, 0xe4, 0x7f, 0x00, 0xa9, 0x3c, 0x5b,
	0x27, 0xe1, 0x33, 0x55, 0x74, 0xb4, 0x68, 0x61, 0x86, 0x35, 0xee, 0x34, 0x18, 0x59, 0x3b,
	0x5c, 0x39, 0x83, 0xcc, 0x70, 0x7c, 0x70, 0x52, 0x98, 0x09, 0xca, 0xca, 0x46, 0x37, 0xc4,
	0x06, 0x5c, 0x49, 0x09, 0xa9, 0x8f, 0x23, 0x20, 0xbb, 0xf6, 0x78, 0xed, 0x23, 0x04, 0x6b,
	0x60, 0xec, 0x1a, 0xf6, 0x69, 0xf5, 0x01, 0xa7, 0xaf, 0xf1, 0x04, 0xe3, 0x13, 0xd9, 0x19,
	0x58, 0x55, 0x7e, 0x87, 0xe1, 0xad, 0x54, 0x03, 0x5f, 0x47, 0xce, 0x67, 0x27, 0xf9, 0x3d,
	0x61, 0x74, 0x3c, 0x12, 0xea, 0x80, 0x58, 0xa6, 0x2f, 0x2b, 0x25, 0x29, 0xb4, 0xfa, 0xaf,
	0xb2, 0x07, 0x7e, 0x1d, 0xb9, 0xe3, 0x64, 0x56, 0xc9, 0x38, 0x78, 0xa6, 0xe3, 0x08, 0xd3,
	0x4a, 0x16, 0x2f, 0x97, 0x83, 0x23, 0x41, 0x8b, 0x8d, 0x5d, 0xe7, 0xb4, 0x8f, 0x0a, 0xb9,
	0x1c, 0x9b, 0xff, 0x6d, 0x91, 0xa8, 0x11, 0xa2, 0xb1, 0x3c, 0xbc, 0xb7, 0x05, 0x3d, 0xc5,
	0xdc, 0x60, 0xe8, 0xdd, 0x5c, 0x7d, 0xcb, 0xe1, 0x74, 0xd7, 0xab, 0xbb, 0x31, 0xc7, 0x2b,
	0x40, 0x23, 0xae, 0x9e, 0xad, 0xf4, 0x9c, 0xe1, 0x7b, 0xa7, 0x92, 0x82, 0xe2, 0x7d, 0xc6,
	0xdf, 0x30, 0xe0, 0x77, 0x82, 0x31, 0x82, 0xa1, 0x0b, 0x3a, 0x19, 0xf6, 0xa2, 0x01, 0x4d,
	0xd3, 0xc3, 0x17, 0xb0, 0x43, 0xb8, 0x5d, 0xa2, 0xab, 0xe3, 0xe4, 0x69, 0xbd, 0x57, 0x21,
	0xea, 0xcd, 0xe0, 0xc5, 0xe6, 0x65, 0x13, 0x96, 0x67, 0x9d, 0xd8, 0x8e, 0xa6, 0xe0, 0x42,
	0xf1, 0x6d, 0x5d, 0x5b, 0xd2, 0x55, 0x20, 0xb9, 0x1e, 0x59, 0x13, 0x3c, 0x17, 0xc2, 0x25,
	0x56, 0xc7,
]);

/**
 * Convert a PEM-encoded PKCS#1 RSA private key to PKCS#8 DER format
 * for Web Crypto import.
 */
function pemToPkcs8Der(pem: string): ArrayBuffer {
	// Strip PEM headers and decode base64
	const b64 = pem
		.replace(/-----BEGIN RSA PRIVATE KEY-----/, '')
		.replace(/-----END RSA PRIVATE KEY-----/, '')
		.replace(/\s/g, '');

	const binaryString = atob(b64);
	const pkcs1Der = new Uint8Array(binaryString.length);
	for (let i = 0; i < binaryString.length; i++) {
		pkcs1Der[i] = binaryString.charCodeAt(i);
	}

	// Wrap PKCS#1 in PKCS#8 envelope
	// PKCS#8 = SEQUENCE { SEQUENCE { OID rsaEncryption, NULL }, OCTET STRING { PKCS#1 } }
	const rsaOid = new Uint8Array([
		0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
		0x01, 0x05, 0x00,
	]);

	// Build the OCTET STRING wrapping PKCS#1
	const octetString = wrapAsn1(0x04, pkcs1Der);

	// Build the outer SEQUENCE
	const innerContent = new Uint8Array(rsaOid.length + octetString.length);
	innerContent.set(rsaOid, 0);
	innerContent.set(octetString, rsaOid.length);

	// Version INTEGER 0
	const version = new Uint8Array([0x02, 0x01, 0x00]);

	const outerContent = new Uint8Array(version.length + innerContent.length);
	outerContent.set(version, 0);
	outerContent.set(innerContent, version.length);

	return wrapAsn1(0x30, outerContent).buffer;
}

function wrapAsn1(tag: number, content: Uint8Array): Uint8Array {
	const len = content.length;
	let header: Uint8Array;

	if (len < 0x80) {
		header = new Uint8Array([tag, len]);
	} else if (len < 0x100) {
		header = new Uint8Array([tag, 0x81, len]);
	} else if (len < 0x10000) {
		header = new Uint8Array([tag, 0x82, (len >> 8) & 0xff, len & 0xff]);
	} else {
		header = new Uint8Array([
			tag,
			0x83,
			(len >> 16) & 0xff,
			(len >> 8) & 0xff,
			len & 0xff,
		]);
	}

	const result = new Uint8Array(header.length + content.length);
	result.set(header, 0);
	result.set(content, header.length);
	return result;
}

let cachedKey: CryptoKey | null = null;

/**
 * Import the hardcoded RSA private key for signing.
 */
async function getSigningKey(
	crypto: Crypto = globalThis.crypto
): Promise<CryptoKey> {
	if (cachedKey) return cachedKey;

	const pkcs8Der = pemToPkcs8Der(RSA_PRIVATE_KEY_PEM);
	cachedKey = await crypto.subtle.importKey(
		'pkcs8',
		pkcs8Der,
		{
			name: 'RSA-PSS',
			hash: 'SHA-256',
		},
		false,
		['sign']
	);
	return cachedKey;
}

/**
 * Sign data using RSA-2048-PSS with SHA-256.
 * Matches hacbrewpack's rsa_sign() function.
 *
 * @param data - The data to sign (typically bytes 0x200-0x400 of the NCA header)
 * @param crypto - Optional Crypto implementation
 * @returns 256-byte RSA-PSS signature
 */
export async function rsaSign(
	data: Uint8Array,
	crypto: Crypto = globalThis.crypto
): Promise<Uint8Array> {
	const key = await getSigningKey(crypto);
	const signature = await crypto.subtle.sign(
		{
			name: 'RSA-PSS',
			saltLength: 32, // SHA-256 digest length
		},
		key,
		data
	);
	return new Uint8Array(signature);
}
