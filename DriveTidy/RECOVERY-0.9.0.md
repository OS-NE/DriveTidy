# DriveTidy 0.9.0 — Recovery inspection improvements

## Fixed

- Recovery inspection now treats a missing original parent directory as an absent source and continues checking the destination. This matters when a restructure operation removes emptied source folders.
- Source and destination checks are isolated. A missing source folder no longer prevents the destination from being inspected.
- Full-file SHA-256 inspection can be cancelled between bounded read chunks.
- History displays inspection progress and provides a Cancel inspection control.
- Inspection reports how many entries were identity-verified complete and how many still need review.
- An unfinished batch can only be marked completed after every recorded operation is classified completed and the stored destination handle identity is confirmed. Finalization requires explicit user confirmation and changes journal metadata only; it never changes files.

## Safety

- Inspection remains read-only.
- No files are moved, overwritten, renamed, or deleted by this change.
- A batch with any ambiguous, inaccessible, missing, or conflicting entry remains unfinished.
- Cancellation leaves the journal unchanged.

## Validation

Source-level review and static syntax checks were performed. A full dependency install, automated test suite, production build, and Windows installer build still need to run in GitHub Actions.
