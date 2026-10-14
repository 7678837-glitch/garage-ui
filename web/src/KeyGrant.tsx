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
  const canSubmit = accessKeyId !== "" && (read || write || owner);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }
    setError(null);
    setSucceeded(false);
    void submit({
      accessKeyId,
      permissions: { read, write, owner },
    }).then(
      () => {
        setSucceeded(true);
      },
      (caught: unknown) => {
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
    <form className="grid gap-3" aria-label={copy("ui.grant.key")} onSubmit={onSubmit}>
      <label className="block">
        <span className="text-sm">{copy("ui.key.2")}</span>
        <select
          className="mt-1 w-full border border-line px-2 py-1"
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
      <label className="block text-sm">
        <input
          type="checkbox"
          checked={read}
          onChange={(event) => setRead(event.target.checked)}
        />{" "}
        {copy("ui.read.2")}</label>
      <label className="block text-sm">
        <input
          type="checkbox"
          checked={write}
          onChange={(event) => setWrite(event.target.checked)}
        />{" "}
        {copy("ui.write.2")}</label>
      <label className="block text-sm">
        <input
          type="checkbox"
          checked={owner}
          onChange={(event) => setOwner(event.target.checked)}
        />{" "}
        {copy("ui.owner.2")}</label>
      {error ? <p role="alert">{error}</p> : null}
      {succeeded ? <p>{copy("ui.key.granted")}</p> : null}
      <button
        className="border border-ink px-3 py-1 text-left"
        type="submit"
        disabled={!canSubmit}
      >
        {copy("ui.grant")}</button>
    </form>
  );
}
