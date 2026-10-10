import { useState, type FormEvent } from "react";

const MIN_FRACTION_DIGITS = 2;

const DECIMAL_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

export type DecimalUnit = (typeof DECIMAL_UNITS)[number];

const SCALE: Record<DecimalUnit, number> = {
  B: 0,
  KB: 3,
  MB: 6,
  GB: 9,
  TB: 12,
  PB: 15,
};

type Amount = { kind: "original" } | { kind: "typed"; text: string };

function isByteDigits(value: string): boolean {
  return /^[0-9]+$/.test(value);
}

function isDecimalUnit(value: string): value is DecimalUnit {
  return DECIMAL_UNITS.some((unit) => unit === value);
}

function formatInUnit(bytes: string, scale: number): string {
  const digits = bytes.replace(/^0+(?=\d)/, "");
  const whole = digits.length > scale ? digits.slice(0, digits.length - scale) : "0";
  let fraction =
    digits.length > scale ? digits.slice(digits.length - scale) : digits.padStart(scale, "0");
  if (fraction.length < MIN_FRACTION_DIGITS) {
    fraction = fraction.padEnd(MIN_FRACTION_DIGITS, "0");
  } else {
    let end = fraction.length;
    while (end > MIN_FRACTION_DIGITS && fraction[end - 1] === "0") {
      end -= 1;
    }
    fraction = fraction.slice(0, end);
  }
  return `${whole}.${fraction}`;
}

function decimalToByteString(text: string, scale: number): string | null {
  const matched = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!matched) {
    return null;
  }
  const whole = matched[1];
  const fraction = matched[2] ?? "";
  if (fraction.length > scale && /[^0]/.test(fraction.slice(scale))) {
    return null;
  }
  const used = fraction.slice(0, scale);
  const raw = `${whole}${used}${"0".repeat(scale - used.length)}`;
  return raw.replace(/^0+(?=\d)/, "");
}

export function CapacityField({
  bytes,
  submit,
}: {
  bytes: string;
  submit: (bytes: string) => void;
}) {
  const [unit, setUnit] = useState<DecimalUnit>("TB");
  const [amount, setAmount] = useState<Amount>({ kind: "original" });
  const [error, setError] = useState<string | null>(null);
  const [seenBytes, setSeenBytes] = useState(bytes);
  if (bytes !== seenBytes) {
    setSeenBytes(bytes);
    setAmount({ kind: "original" });
    setError(null);
  }

  const sourceValid = isByteDigits(bytes);
  const shown =
    amount.kind === "typed" ? amount.text : sourceValid ? formatInUnit(bytes, SCALE[unit]) : "";
  const alertText = sourceValid ? error : "Capacity must be a whole number of bytes";

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!sourceValid) {
      return;
    }
    if (amount.kind === "original") {
      setError(null);
      submit(bytes);
      return;
    }
    const next = decimalToByteString(amount.text, SCALE[unit]);
    if (next === null) {
      setError("Enter a whole number of bytes");
      return;
    }
    setError(null);
    submit(next);
  }

  return (
    <form className="grid gap-3" aria-label="Node capacity" onSubmit={onSubmit}>
      <label className="block">
        <span className="text-sm">Capacity</span>
        <input
          className="mt-1 w-full border border-line px-2 py-1"
          inputMode="decimal"
          autoComplete="off"
          value={shown}
          onChange={(event) => {
            setAmount({ kind: "typed", text: event.target.value });
            setError(null);
          }}
        />
      </label>
      <label className="block">
        <span className="text-sm">Unit</span>
        <select
          className="mt-1 w-full border border-line px-2 py-1"
          value={unit}
          onChange={(event) => {
            const next = event.target.value;
            if (!isDecimalUnit(next)) {
              return;
            }
            setUnit(next);
            setError(null);
          }}
        >
          {DECIMAL_UNITS.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      </label>
      {alertText ? <p role="alert">{alertText}</p> : null}
      <button className="border border-ink px-3 py-1 text-left" type="submit">
        Save
      </button>
    </form>
  );
}
