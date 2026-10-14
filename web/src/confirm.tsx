import { useId, useLayoutEffect, useRef, useState } from "react";
import { copy, fill } from "./i18n";

const RISK = {
  rename: "low",
  quota: "low",
  "website-document": "low",
  "delete-object": "medium",
  "revoke-permission": "medium",
  "delete-empty-bucket": "medium",
  "delete-key": "medium",
  "recursive-delete": "high",
  "batch-delete": "high",
  "clear-block": "high",
  "repair": "high",
  "worker-variable": "high",
  "skip-dead-node": "high",
  "apply-layout": "high",
  "enable-website": "high",
  "create-admin-token": "high",
  "update-admin-token": "high",
  "delete-admin-token": "medium",
} as const;

export type WriteAction = keyof typeof RISK;
export type RiskLevel = (typeof RISK)[WriteAction];

type ActionAt<Level extends RiskLevel> = {
  [Action in WriteAction]: (typeof RISK)[Action] extends Level ? Action : never;
}[WriteAction];

type ConfirmFields = {
  name: string;
  consequence: string;
  onCancel: () => void;
  onConfirm: () => void;
  pending?: boolean;
};

export type ConfirmDialogProps = ConfirmFields &
  ({ action: ActionAt<"medium"> } | { action: ActionAt<"high">; scope: string });

function isWriteAction(action: string): action is WriteAction {
  return Object.hasOwn(RISK, action);
}

export function riskOf(action: string): RiskLevel {
  if (!isWriteAction(action)) {
    throw new Error(fill(copy("ui.unknown.write.action"), { action: action }));
  }
  return RISK[action];
}

function openDialog(dialog: HTMLDialogElement) {
  if (typeof dialog.showModal === "function") {
    if (!dialog.open) {
      dialog.showModal();
    }
    return;
  }
  dialog.setAttribute("open", "");
}

export function ConfirmDialog(props: ConfirmDialogProps) {
  const { action, name, consequence, onCancel, onConfirm, pending = false } = props;
  const level = RISK[action];
  const scope = "scope" in props ? props.scope : null;
  const [typed, setTyped] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const matched = typed === name;
  const canConfirm = level === "medium" || matched;

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    openDialog(dialog);
    cancelRef.current?.focus();
  }, [name]);

  return (
    <dialog
      ref={dialogRef}
      aria-modal="true"
      aria-labelledby={titleId}
      className="ui-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
          return;
        }
        if (event.key !== "Enter" || level !== "high") {
          return;
        }
        if (!(event.target instanceof HTMLInputElement)) {
          return;
        }
        event.preventDefault();
        if (matched && !pending) {
          onConfirm();
        }
      }}
    >
      <h3 id={titleId} className="font-medium">
        {fill(copy("ui.confirm"), { name: name })}</h3>
      <p>{consequence}</p>
      {scope !== null ? <p>{scope}</p> : null}
      {level === "high" ? (
        <label className="mt-2 block">
          {fill(copy("ui.type.to.confirm"), { name: name })}<input
            className="ui-input"
            value={typed}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setTyped(event.target.value);
            }}
          />
        </label>
      ) : null}
      <button
        ref={cancelRef}
        className="ui-button"
        type="button"
        onClick={onCancel}
      >
        {copy("ui.cancel")}</button>
      <button
        className="ui-button ui-button-danger"
        type="button"
        disabled={!canConfirm || pending}
        onClick={() => {
          if (canConfirm && !pending) {
            onConfirm();
          }
        }}
      >
        {pending ? copy("ui.working") : copy("ui.confirm.2")}
      </button>
    </dialog>
  );
}
