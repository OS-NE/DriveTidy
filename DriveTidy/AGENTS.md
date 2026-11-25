<!-- LOVABLE:BEGIN -->

> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.

<!-- LOVABLE:END -->

# Project rules

- Batch usage aggregates provider-reported tokens and naming requests only; missing usage remains unknown and token totals never masquerade as actual credit deductions.
- Provider settings and the rename panel share connection state through a tool-scoped context, so live rechecks update both surfaces without requiring drive selection.
- The app has no password gate and no accounts; the index route renders directly with no server loader.
- All file access is client-side via the File System Access API (src/lib/fs.ts); files never upload — only downscaled JPEG previews go to the local AI.
- Pure planning/naming rules live in src/lib/organize.ts with tests in src/test/organize.test.ts, so rules stay testable without browser APIs.
- Ollama (local AI) is the only AI provider and is called directly from the browser (src/lib/ollama.ts) because it runs on the user's PC, unreachable from any server; there are no API keys or cloud AI code.
- Moves copy-then-verify-then-delete when native handle.move() is unavailable: the copy is read back and compared byte-for-byte before the original is removed, failed/stopped copies are deleted, and the source is re-checked (same entry, same bytes) right before removal, so a bad copy or a changed source never loses data. Native move() falls back to the copy only on "unsupported" errors (incl. AbortError not caused by our own stop); permission errors are reported, never retried.
- Duplicates are only actionable when full contents are verified (incremental SHA-256 in src/lib/sha256.ts, re-checked right before delete/move); sampled fingerprints of large files are candidates only, because sampled matches can be different files.
- Result lists use bounded pages and media previews decode only near the viewport; folder grouping appends in place to avoid drive-sized memory spikes.
- Offline installability uses vite-plugin-pwa (generateSW, /sw.js, NetworkFirst navigations, navigateFallback null and modifyURLPrefix client/ → / because pages are SSR and the client build sits in client/); src/lib/pwa.ts is the only registrar and refuses dev, iframes, and Lovable preview hostnames.
- The operation journal (src/lib/journal.ts, IndexedDB, strict-durability commits awaited on oncomplete) and pure recovery classification (src/lib/recovery.ts) record and classify only; recovery never mutates files, so a crash is always resolved by an explicit user choice.
