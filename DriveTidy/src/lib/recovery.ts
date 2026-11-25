// Pure recovery classification (plan section D). Labels only — never mutates anything.

export type Presence = "absent" | "match" | "differs" | "unreadable";
export interface Observation {
  access: "ok" | "missing"; // permission missing or drive absent → "missing"
  source: Presence; // vs sourceSha256 (and size/lastModified)
  dest: Presence; // final destination vs sourceSha256/finalSha256
  staging?: "absent" | "present";
  sourceSame?: boolean; // stored source handle isSameEntry
  destSame?: boolean; // stored final handle isSameEntry
  stagingSame?: boolean; // stored staging handle isSameEntry
  stagingVerified?: boolean;
  dirPresent?: boolean; // for dirs records
}

export type Outcome =
  | "not-started"
  | "conflict"
  | "completed"
  | "probable-completion"
  | "reverted-safe"
  | "resume-placement"
  | "partial-final"
  | "awaiting-finalize"
  | "needs-review"
  | "not-deleted"
  | "deletion-unconfirmed"
  | "dir-ownership-unknown"
  | "waiting-for-access";

export interface Classification {
  outcome: Outcome;
  label: string;
  actions: string[];
}

const C = (outcome: Outcome, label: string, actions: string[] = []): Classification => ({
  outcome,
  label,
  actions,
});

export function classify(state: string, o: Observation): Classification {
  if (o.access === "missing")
    return C("waiting-for-access", "Waiting for access to the drive", ["Reconnect"]);

  if (state === "create-intent")
    return o.dirPresent
      ? C(
          "dir-ownership-unknown",
          "Folder exists, but DriveTidy can't tell who created it; it will never be removed automatically",
        )
      : C("not-started", "Folder not created");

  if (state === "delete-intent" || state === "delete-revalidate") {
    if (o.source === "match") return C("not-deleted", "Not deleted", ["Confirm delete again"]);
    if (o.source === "absent")
      return C("deletion-unconfirmed", "Absent — deletion outcome unconfirmed");
    return C("needs-review", "File changed; not deleted");
  }

  if (o.source === "absent" && o.dest === "absent") return C("needs-review", "File missing");
  const partialOk = state === "final-created" || state === "final-copying";
  if (!partialOk && o.source !== "absent" && o.dest !== "absent" && o.source !== o.dest)
    return C("needs-review", "Original and copy differ");

  if (o.source === "absent" && o.dest === "match")
    return o.destSame
      ? C("completed", "Moved")
      : C("probable-completion", "Probable completion — identity unconfirmed", [
          "Confirm identity",
        ]);
  if (o.source === "absent")
    return C("needs-review", "Original gone and destination doesn't match");

  if (o.source === "differs" || o.source === "unreadable")
    return C("conflict", "File changed after it was fingerprinted", ["Re-plan"]);

  // source matches from here on
  switch (state) {
    case "planned":
    case "hashed":
    case "native-intent":
      if (o.dest === "absent") return C("not-started", "Not moved yet", ["Resume"]);
      break;
    case "native-moved":
      if (o.dest === "differs") return C("conflict", "Moved file doesn't match; kept in place");
      break;
    case "staging-intent":
      if (o.staging === "present") return C("needs-review", "Leftover file of unproven origin");
      return C("reverted-safe", "Not copied yet", ["Resume"]);
    case "staging-created":
    case "copied":
      if (o.staging === "present")
        return o.stagingSame
          ? C("reverted-safe", "Partial copy left over", ["Remove leftover partial copy", "Resume"])
          : C("needs-review", "Leftover file of unproven origin");
      return C("reverted-safe", "Copy not finished", ["Resume"]);
    case "staging-verified":
      if (o.dest === "absent")
        return C("resume-placement", "Verified copy waiting to be placed", ["Resume"]);
      break;
    case "final-create-intent":
      if (o.dest === "absent")
        return C("resume-placement", "Verified copy waiting to be placed", ["Resume"]);
      return C("needs-review", "File at destination not proven ours");
    case "final-created":
    case "final-copying":
      if (o.dest === "match" && o.destSame)
        return C("awaiting-finalize", "Both copies match", ["Finish move", "Keep both"]);
      if (o.dest !== "absent")
        return o.destSame && o.stagingVerified
          ? C("partial-final", "Partial final copy", ["Remove partial final copy", "Resume"])
          : C("needs-review", "File at destination not proven ours; staging kept");
      return C("resume-placement", "Verified copy waiting to be placed", ["Resume"]);
    case "final-verified":
    case "placed":
    case "staging-removal-intent":
    case "source-revalidate":
    case "source-removal-intent":
      if (o.dest === "match")
        return C("awaiting-finalize", "Both copies match", ["Finish move", "Keep both"]);
      break;
  }
  if (o.dest !== "absent") return C("needs-review", "Unexpected file at destination; untouched");
  return C("needs-review", "Unrecognised step");
}
