/**
 * `@tootallnate/fmod-bank` — parser for FMOD Studio `.bank` files.
 *
 * An FMOD Studio Bank is a RIFF container with form-type `"FEV "`.
 * Its top-level layout (the only part we actually care about):
 *
 *   ┌─────────────────────────────────────────────────────────┐
 *   │ "RIFF" / size / "FEV "                                  │
 *   │ "FMT " size=8                                           │  format magic + version
 *   │ LIST(PROJ) — project metadata tree (BSSL, EVTS, WAIS,…) │  small
 *   │ SNDH size=12 — flags + offset + size of FSB5 audio      │  ←──┐
 *   │ STDT, STBL, HASH, DEL, MUTE, REFI, PLAT (mostly empty)  │     │
 *   │ "SND " size=N — embedded FSB5 sample bank               │  ◄──┘
 *   └─────────────────────────────────────────────────────────┘
 *
 * # Encryption (the catch)
 *
 * FMOD Studio supports per-game XOR encryption on bank loading
 * (`FMOD_STUDIO_LOAD_BANK_DECRYPT` flag with a password string).
 * When encrypted:
 *
 *   - The bank file itself looks normal (RIFF/FEV header + chunks).
 *   - Only the **payload of the SND chunk** is encrypted (everything
 *     else — chunk headers, project metadata, SNDH offsets — stays
 *     in cleartext, which is how we can find the SND chunk at all).
 *   - The encryption is per-byte: for each byte X in the encrypted
 *     region, decrypted byte = `reverseBitsInByte(X) ^ key[i % keyLen]`,
 *     where `reverseBitsInByte` swaps high/low nibbles and reverses
 *     bit order *within* each nibble (so bit 7 ↔ bit 4, bit 6 ↔ bit 5,
 *     bit 3 ↔ bit 0, bit 2 ↔ bit 1).
 *
 * Some games' keys are public knowledge (vgmstream's `fsb_keys.h`,
 * CUE4Parse's `Fsb5Decryption.cs`, FMODBankDecryptor's notes).
 * We embed the list as `KNOWN_BANK_KEYS` and provide
 * `tryKnownKeysAndDecrypt()` to auto-detect the right one by
 * checking for the `FSB5` magic post-decryption.
 *
 * References:
 *   - [FMODBankDecryptor](https://github.com/9382/FMODBankDecryptor) (MIT)
 *   - [CUE4Parse Fsb5Decryption.cs](https://github.com/FabianFG/CUE4Parse/blob/master/CUE4Parse/UE4/FMod/Fsb5Decryption.cs) (Apache 2.0)
 *   - [openFmodBank](https://github.com/inconsistentPassion/openFmodBank) (MIT)
 *   - [vgmstream `fsb_keys.h`](https://github.com/vgmstream/vgmstream/blob/master/src/meta/fsb_keys.h) (ISC)
 */

export {
	BANK_RIFF_MAGIC,
	BANK_FORM_TYPE,
	type BankChunk,
	type ParsedFmodBank,
	parseFmodBank,
	isFmodBank,
} from './parse.js';

export {
	reverseBitsInByte,
	decryptBankSndPayload,
	tryKnownKeysAndDecrypt,
	KNOWN_BANK_KEYS,
	type KnownBankKey,
	type DecryptResult,
} from './decrypt.js';

export { extractFsb5FromBank, type Fsb5ExtractResult } from './extract.js';
