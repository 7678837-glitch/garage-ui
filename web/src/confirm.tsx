import { Button, Dialog, Flex, TextField } from "@radix-ui/themes";
import { useRef, useState } from "react";
import { copy, fill } from "./i18n";

const RISK = {
  rename: "low",
  quota: "low",
  "website-document": "low",
  "delete-object": "medium",
  "revoke-permission": "medium",
  "delete-empty-bucket": "medium",
  "delete-key": "medium",
  "reveal-secret": "medium",
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

export function ConfirmDialog(props: ConfirmDialogProps) {
  const { action, name, consequence, onCancel, onConfirm, pending = false } = props;
  const level = RISK[action];
  const scope = "scope" in props ? props.scope : null;
  const [typed, setTyped] = useState("");
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [opener] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const matched = typed === name;
  const canConfirm = level === "medium" || matched;

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open && !pending) onCancel(); }}>
      <Dialog.Content size={{ initial: "2", sm: "3" }} maxWidth="480px" maxHeight="calc(100dvh - 48px)" aria-busy={pending}
        onOpenAutoFocus={(event) => { event.preventDefault(); cancelRef.current?.focus(); }}
        onCloseAutoFocus={(event) => { event.preventDefault(); if (opener?.isConnected) opener.focus(); }}
        onEscapeKeyDown={(event) => { if (pending) event.preventDefault(); }}
        onInteractOutside={(event) => { if (pending) event.preventDefault(); }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || level !== "high" || !(event.target instanceof HTMLInputElement)) return;
          event.preventDefault();
          if (matched && !pending) onConfirm();
        }}>
        <Dialog.Title>{fill(copy("ui.confirm"), { name })}</Dialog.Title>
        <Dialog.Description>{consequence}</Dialog.Description>
        {scope !== null ? <p className="ui-confirm-scope">{scope}</p> : null}
        {level === "high" ? <label className="ui-field ui-confirm-name">
          {fill(copy("ui.type.to.confirm"), { name })}
          <TextField.Root size="2" value={typed} autoComplete="off" spellCheck={false}
            onChange={(event) => setTyped(event.target.value)} />
        </label> : null}
        <Flex gap="3" mt="5" justify="end" wrap="wrap">
          <Button ref={cancelRef} size="2" color="gray" variant="soft" type="button" aria-disabled={pending}
            onClick={() => { if (!pending) onCancel(); }}>{copy("ui.cancel")}</Button>
          <Button size="2" color="red" type="button" disabled={!canConfirm || pending}
            onClick={() => { if (canConfirm && !pending) onConfirm(); }}>
            {pending ? copy("ui.working") : copy("ui.confirm.2")}
          </Button>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}
