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
        <select
          className="ui-input"
          value={accessKeyId}
          onChange={(event) => setAccessKeyId(event.target.value)}
        >
          <option value="">{copy("ui.select.a.key")}</option>
          {keys.map((key) => (
            <option key={key.id} value={key.id}>
              {key.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={read}
          onChange={(event) => setRead(event.target.checked)}
        />{" "}
        {copy("ui.read.2")}</label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={write}
          onChange={(event) => setWrite(event.target.checked)}
        />{" "}
        {copy("ui.write.2")}</label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={owner}
          onChange={(event) => setOwner(event.target.checked)}
        />{" "}
        {copy("ui.owner.2")}</label>
      {error ? <p role="alert">{error}</p> : null}
      {succeeded ? <p>{copy("ui.key.granted")}</p> : null}
      <button
        className="ui-button"
        type="submit"
        disabled={!canSubmit || pending}
      >
        {copy(pending ? "ui.granting" : "ui.grant")}</button>
    </form>
  );
}
