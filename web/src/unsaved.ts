export type SavePhase = "idle" | "pending" | "success" | "failed";

const leavePrompt = "Leave this page? Unsaved changes will be lost.";

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
  if (ignoredArrival !== null) {
    const arrival = ignoredArrival;
    ignoredArrival = null;
    // 换地址时 location 会先变。仍停在刚允许的地址上，说明这是晚到的那一次。
    if (window.location.hash === arrival) {
      return;
    }
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
  if (dirtyIds.size > 0 && !window.confirm(leavePrompt)) {
    return false;
  }
  // 浏览器在 effect 之后才投递 hashchange。干净页也要记下目标，否则目标页先标脏再收到这次导航，会再问一次。
  ignoredArrival = next;
  return true;
}
