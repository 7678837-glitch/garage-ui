import { Button, Checkbox, Select } from "@radix-ui/themes";
import { useState, type FormEvent } from "react";
import { copy } from "./i18n";

export type KeyGrantInput = {
  accessKeyId: string;
  permissions: {
    read: boolean;
    write: boolean;
    owner: boolean;
  };
};

export type KeyOption = {
  id: string;
  label: string;
};

export function KeyGrant({
  keys,
  submit,
}: {
  keys: KeyOption[];
  submit: (input: KeyGrantInput) => Promise<void>;
}) {
  const [accessKeyId, setAccessKeyId] = useState("");
  const [read, setRead] = useState(false);
  const [write, setWrite] = useState(false);
  const [owner, setOwner] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [succeeded, setSucceeded] = useState(false);
  const [pending, setPending] = useState(false);
  const canSubmit = accessKeyId !== "" && (read || write || owner);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || pending) {
      return;
    }
    setPending(true);
    setError(null);
    setSucceeded(false);
    void submit({
      accessKeyId,
      permissions: { read, write, owner },
    }).then(
      () => {
        setPending(false);
        setSucceeded(true);
      },
      (caught: unknown) => {
        setPending(false);
        setSucceeded(false);
        if (caught instanceof Error && caught.message.length > 0) {
          setError(caught.message);
          return;
        }
        setError(copy("ui.request.failed.2"));
      },
    );
  }

  return (
    <form className="ui-form" aria-label={copy("ui.grant.key")} onSubmit={onSubmit}>
      <label className="ui-field">
        <span className="text-sm">{copy("ui.key.2")}</span>
        <Select.Root value={accessKeyId} onValueChange={setAccessKeyId} disabled={pending}>
          <Select.Trigger aria-label={copy("ui.key.2")} placeholder={copy("ui.select.a.key")} />
          <Select.Content>{keys.map((key) => (
            <Select.Item key={key.id} value={key.id}>{key.label}</Select.Item>
          ))}</Select.Content>
        </Select.Root>
      </label>
      <label className="ui-checkbox-field">
        <Checkbox disabled={pending} checked={read} onCheckedChange={(checked) => setRead(checked === true)} />{" "}
        {copy("ui.read.2")}</label>
      <label className="ui-checkbox-field">
        <Checkbox disabled={pending} checked={write} onCheckedChange={(checked) => setWrite(checked === true)} />{" "}
        {copy("ui.write.2")}</label>
      <label className="ui-checkbox-field">
        <Checkbox disabled={pending} checked={owner} onCheckedChange={(checked) => setOwner(checked === true)} />{" "}
        {copy("ui.owner.2")}</label>
      {error ? <p role="alert">{error}</p> : null}
      {succeeded ? <p>{copy("ui.key.granted")}</p> : null}
      <Button size="2" variant="solid"
        type="submit"
        disabled={!canSubmit || pending}
      >
        {copy(pending ? "ui.granting" : "ui.grant")}</Button>
    </form>
  );
}
