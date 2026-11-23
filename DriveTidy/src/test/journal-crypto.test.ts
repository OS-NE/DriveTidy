import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptJournalBackup,
  encryptJournalBackup,
  isEncryptedJournalBackup,
} from "@/lib/journal-crypto";

Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });

describe("encrypted journal backups", () => {
  it("encrypts without exposing metadata and round-trips with the passphrase", async () => {
    const cleartext = JSON.stringify({
      format: "drivetidy-journal-backup",
      secretPath: "private/folder",
    });
    const encrypted = await encryptJournalBackup(cleartext, "a sufficiently long passphrase");

    expect(encrypted).not.toContain("private/folder");
    expect(isEncryptedJournalBackup(JSON.parse(encrypted))).toBe(true);
    await expect(decryptJournalBackup(encrypted, "a sufficiently long passphrase")).resolves.toBe(
      cleartext,
    );
  });

  it("uses a fresh salt and nonce for every export", async () => {
    const cleartext = "same history";
    const first = JSON.parse(
      await encryptJournalBackup(cleartext, "a sufficiently long passphrase"),
    );
    const second = JSON.parse(
      await encryptJournalBackup(cleartext, "a sufficiently long passphrase"),
    );
    expect(first.salt).not.toBe(second.salt);
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it("rejects short passphrases, wrong passphrases and tampering", async () => {
    await expect(encryptJournalBackup("data", "short")).rejects.toThrow(/12 characters/);
    const encrypted = JSON.parse(
      await encryptJournalBackup("data", "a sufficiently long passphrase"),
    );
    await expect(
      decryptJournalBackup(JSON.stringify(encrypted), "the wrong passphrase"),
    ).rejects.toThrow(/passphrase or file integrity/);
    encrypted.ciphertext = `${encrypted.ciphertext.slice(0, -4)}AAAA`;
    await expect(
      decryptJournalBackup(JSON.stringify(encrypted), "a sufficiently long passphrase"),
    ).rejects.toThrow();
  });

  it("rejects malformed envelope parameters before deriving a key", async () => {
    const encrypted = JSON.parse(
      await encryptJournalBackup("data", "a sufficiently long passphrase"),
    );
    encrypted.iterations = 1;
    await expect(
      decryptJournalBackup(JSON.stringify(encrypted), "a sufficiently long passphrase"),
    ).rejects.toThrow(/malformed/);
  });
});
