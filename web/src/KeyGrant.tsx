import { useState, type FormEvent } from "react";

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
        setError("Request failed");
      },
    );
  }

  return (
    <form className="grid gap-3" aria-label="Grant key" onSubmit={onSubmit}>
      <label className="block">
        <span className="text-sm">Key</span>
        <select
          className="mt-1 w-full border border-neutral-300 px-2 py-1"
          value={accessKeyId}
          onChange={(event) => setAccessKeyId(event.target.value)}
        >
          <option value="">Select a key</option>
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
        Read
      </label>
      <label className="block text-sm">
        <input
          type="checkbox"
          checked={write}
          onChange={(event) => setWrite(event.target.checked)}
        />{" "}
        Write
      </label>
      <label className="block text-sm">
        <input
          type="checkbox"
          checked={owner}
          onChange={(event) => setOwner(event.target.checked)}
        />{" "}
        Owner
      </label>
      {error ? <p role="alert">{error}</p> : null}
      {succeeded ? <p>Key granted</p> : null}
      <button
        className="border border-neutral-900 px-3 py-1 text-left"
        type="submit"
        disabled={!canSubmit}
      >
        Grant
      </button>
    </form>
  );
}
