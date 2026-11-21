const FORMAT = "drivetidy-encrypted-journal-backup";
const VERSION = 1;
const ITERATIONS = 310_000;

type EncryptedBackup = {
  format: typeof FORMAT;
  version: typeof VERSION;
  kdf: "PBKDF2-SHA-256";
  cipher: "AES-256-GCM";
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
};

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64(value: unknown, maxBytes: number): Uint8Array {
  if (typeof value !== "string" || value.length > Math.ceil((maxBytes * 4) / 3) + 4) {
    throw new Error("Encrypted backup contains invalid data");
  }
  try {
    const binary = atob(value);
    if (binary.length > maxBytes) throw new Error("Encrypted backup contains invalid data");
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    throw new Error("Encrypted backup contains invalid data");
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(new TextEncoder().encode(passphrase)),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: toArrayBuffer(salt), iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export function isEncryptedJournalBackup(value: unknown): boolean {
  return !!value && typeof value === "object" && (value as { format?: unknown }).format === FORMAT;
}

export async function encryptJournalBackup(plaintext: string, passphrase: string): Promise<string> {
  if (passphrase.length < 12) throw new Error("Use a passphrase with at least 12 characters");
  if (plaintext.length > 50 * 1024 * 1024)
    throw new Error("Backup is larger than the 50 MB export limit");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, ITERATIONS);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(new TextEncoder().encode(plaintext)),
  );
  const backup: EncryptedBackup = {
    format: FORMAT,
    version: VERSION,
    kdf: "PBKDF2-SHA-256",
    cipher: "AES-256-GCM",
    iterations: ITERATIONS,
    salt: encodeBase64(salt),
    iv: encodeBase64(iv),
    ciphertext: encodeBase64(new Uint8Array(ciphertext)),
  };
  return JSON.stringify(backup, null, 2);
}

export async function decryptJournalBackup(json: string, passphrase: string): Promise<string> {
  if (!passphrase) throw new Error("Enter the backup passphrase");
  if (json.length > 70 * 1024 * 1024)
    throw new Error("Encrypted backup is larger than the 50 MB import limit");
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("Encrypted backup is not valid JSON");
  }
  if (!raw || typeof raw !== "object") throw new Error("Encrypted backup has an invalid structure");
  const backup = raw as Partial<EncryptedBackup>;
  if (
    backup.format !== FORMAT ||
    backup.version !== VERSION ||
    backup.kdf !== "PBKDF2-SHA-256" ||
    backup.cipher !== "AES-256-GCM" ||
    backup.iterations !== ITERATIONS
  ) {
    throw new Error("Unsupported or malformed encrypted DriveTidy backup");
  }
  const salt = decodeBase64(backup.salt, 16);
  const iv = decodeBase64(backup.iv, 12);
  const ciphertext = decodeBase64(backup.ciphertext, 52 * 1024 * 1024);
  if (salt.length !== 16 || iv.length !== 12 || ciphertext.length < 16)
    throw new Error("Encrypted backup contains invalid data");
  try {
    const key = await deriveKey(passphrase, salt, ITERATIONS);
    const clear = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv) },
      key,
      toArrayBuffer(ciphertext),
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(clear);
  } catch {
    throw new Error("Could not decrypt backup. Check the passphrase or file integrity.");
  }
}
