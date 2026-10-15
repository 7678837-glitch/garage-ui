import { Button, Dialog, TextField } from "@radix-ui/themes";
import { useRef, useState } from "react";
import { copy } from "./i18n";

async function copySecret(secret: string): Promise<"copied" | "select"> {
  const clipboard = navigator.clipboard;
  if (!window.isSecureContext || typeof clipboard?.writeText !== "function") return "select";
  try {
    await clipboard.writeText(secret);
    return "copied";
  } catch {
    return "select";
  }
}

export function SecretDialog({ secret, title, label, description, onClose, returnFocus }: {
  secret: string;
  title: string;
  label: string;
  description: string;
  onClose: () => void;
  returnFocus: HTMLButtonElement | null;
}) {
  const copyRef = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Content maxWidth="480px" onCloseAutoFocus={(event) => { event.preventDefault(); if (returnFocus?.isConnected) returnFocus.focus(); }} onOpenAutoFocus={(event) => { event.preventDefault(); copyRef.current?.focus(); }}>
        <Dialog.Title>{title}</Dialog.Title>
        <Dialog.Description>{description}</Dialog.Description>
        <label className="ui-field">
          <span>{label}</span>
          <TextField.Root size="2" readOnly autoComplete="off" type={visible ? "text" : "password"} value={secret} />
        </label>
        <div className="ui-actions">
          <Button size="2" variant="soft" color="gray" type="button" onClick={() => setVisible(true)}>{copy("ui.show.secret")}</Button>
          <Button size="2" variant="soft" color="gray" type="button" ref={copyRef} onClick={() => {
            void copySecret(secret).then((result) => {
              if (result === "copied") { setFeedback(copy("ui.copied")); return; }
              setVisible(true);
              setFeedback(copy("ui.select.the.secret.and.copy.it"));
            });
          }}>{copy("ui.copy.secret")}</Button>
          <Button size="2" variant="soft" color="gray" type="button" onClick={onClose}>{copy("ui.i.have.saved.it")}</Button>
        </div>
        {feedback ? <p role="status">{feedback}</p> : null}
      </Dialog.Content>
    </Dialog.Root>
  );
}
