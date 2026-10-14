import { copy } from "./i18n";
export type SavePhase = "idle" | "pending" | "success" | "failed";

function leavePrompt(): string {
  return copy("ui.leave.this.page.unsaved.changes.will.be.lost");
}

const dirtyIds = new Set<string>();
let watching = false;
let ignoredArrival: string | null = null;
let reverting = false;

export function savePhase(pending: boolean, failed: boolean, succeeded: boolean): SavePhase {
  if (pending) {
    return "pending";
  }
  if (failed) {
    return "failed";
  }
  if (succeeded) {
    return "success";
  }
  return "idle";
}

export function saveStatus(phase: SavePhase, dirty: boolean, saved: string): string | null {
  switch (phase) {
    case "pending":
      return copy("ui.saving");
    case "failed":
      return copy("ui.save.failed");
    case "idle":
      return dirty ? copy("ui.unsaved.changes") : null;
    case "success":
      return dirty ? copy("ui.unsaved.changes") : saved;
    default: {
      const neverPhase: never = phase;
      return neverPhase;
    }
  }
}

function onBeforeUnload(event: BeforeUnloadEvent) {
  event.preventDefault();
}

function previousHash(oldURL: string): string {
  try {
    return new URL(oldURL).hash;
  } catch {
    return window.location.hash;
  }
}

function onHashChange(event: HashChangeEvent) {
  if (reverting) {
    reverting = false;
    return;
  }
  if (ignoredArrival !== null) {
    const arrival = ignoredArrival;
    ignoredArrival = null;
    // The location changes before this handler runs. Staying on the hash we just allowed means this event is the late one.
    if (window.location.hash === arrival) {
      return;
    }
  }
  if (dirtyIds.size === 0) {
    return;
  }
  if (window.confirm(leavePrompt())) {
    return;
  }
  const previous = previousHash(event.oldURL);
  if (previous === window.location.hash) {
    return;
  }
  // Writing the old hash fires hashchange again. Do not ask on that one.
  reverting = true;
  window.location.hash = previous;
}

function watchLeave() {
  if (dirtyIds.size > 0 && !watching) {
    // The upload panel owns window.onbeforeunload. Listen separately so this does not replace it.
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("hashchange", onHashChange, true);
    watching = true;
    return;
  }
  if (dirtyIds.size === 0 && watching) {
    window.removeEventListener("beforeunload", onBeforeUnload);
    window.removeEventListener("hashchange", onHashChange, true);
    watching = false;
    ignoredArrival = null;
    reverting = false;
  }
}

export function setFormDirty(id: string, isDirty: boolean) {
  if (isDirty) {
    dirtyIds.add(id);
  } else {
    dirtyIds.delete(id);
  }
  watchLeave();
}

export function releaseHash(next: string): boolean {
  if (window.location.hash === next) {
    return true;
  }
  if (dirtyIds.size > 0 && !window.confirm(leavePrompt())) {
    return false;
  }
  // The browser delivers hashchange after the effect. Record the target on a clean page too, or the next page can be marked dirty before it sees this navigation and ask again.
  ignoredArrival = next;
  return true;
}
