export type SavePhase = "idle" | "pending" | "success" | "failed";

const leavePrompt = "Leave this page? Unsaved changes will be lost.";

const dirtyIds = new Set<string>();
let watching = false;
let skipNextHashChange = false;
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
      return "Saving";
    case "failed":
      return "Save failed";
    case "idle":
      return dirty ? "Unsaved changes" : null;
    case "success":
      return dirty ? "Unsaved changes" : saved;
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
  if (skipNextHashChange) {
    skipNextHashChange = false;
    return;
  }
  if (dirtyIds.size === 0) {
    return;
  }
  if (window.confirm(leavePrompt)) {
    return;
  }
  const previous = previousHash(event.oldURL);
  if (previous === window.location.hash) {
    return;
  }
  // 写回旧地址会再触发一次 hashchange。这次不能再问。
  reverting = true;
  window.location.hash = previous;
}

function watchLeave() {
  if (dirtyIds.size > 0 && !watching) {
    // 上传面板占用 window.onbeforeunload。这里只能另外监听，避免把它盖掉。
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("hashchange", onHashChange, true);
    watching = true;
    return;
  }
  if (dirtyIds.size === 0 && watching) {
    window.removeEventListener("beforeunload", onBeforeUnload);
    window.removeEventListener("hashchange", onHashChange, true);
    watching = false;
    skipNextHashChange = false;
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
  if (dirtyIds.size === 0 || window.location.hash === next) {
    return true;
  }
  if (!window.confirm(leavePrompt)) {
    return false;
  }
  skipNextHashChange = true;
  return true;
}
