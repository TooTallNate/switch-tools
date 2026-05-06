import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatBytes(n: number | bigint | undefined): string {
  if (n === undefined) return ""
  const num = typeof n === "bigint" ? Number(n) : n
  if (!Number.isFinite(num) || num < 0) return "?"
  if (num < 1024) return `${num} B`
  const units = ["KB", "MB", "GB", "TB"]
  let val = num / 1024
  let i = 0
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024
    i++
  }
  return `${val.toFixed(val < 10 ? 2 : 1)} ${units[i]}`
}

export function bytesToHex(bytes: Uint8Array | ArrayBuffer): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ""
  for (let i = 0; i < u8.length; i++) {
    s += u8[i].toString(16).padStart(2, "0")
  }
  return s
}
