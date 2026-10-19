import { useState, type ReactNode } from "react";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";

// Plain placeholder forms for the operations tabs. Checks and wording live in
// the client-runtime view models; these only hold the typed text until the
// action resolves.

/** One text field and a submit button; clears itself when the action succeeds. */
export function TextActionForm(props: {
  label: string;
  placeholder?: string;
  submitLabel: string;
  initial?: string;
  onSubmit: (text: string) => Promise<boolean>;
  children?: ReactNode;
}) {
  const [text, setText] = useState(props.initial ?? "");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        const done = await props.onSubmit(text);
        setBusy(false);
        if (done) setText(props.initial ?? "");
      }}
    >
      {props.children}
      <Input
        size="sm"
        aria-label={props.label}
        placeholder={props.placeholder ?? props.label}
        className="min-w-48 flex-1"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <Button type="submit" size="sm" variant="outline" disabled={busy}>
        {props.submitLabel}
      </Button>
    </form>
  );
}

/** Two text fields (e.g. a value and the reason for it) and a submit button. */
export function PairActionForm(props: {
  firstLabel: string;
  secondLabel: string;
  submitLabel: string;
  initialFirst?: string;
  onSubmit: (first: string, second: string) => Promise<boolean>;
}) {
  const [first, setFirst] = useState(props.initialFirst ?? "");
  const [second, setSecond] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        const done = await props.onSubmit(first, second);
        setBusy(false);
        if (done) setSecond("");
      }}
    >
      <Input
        size="sm"
        aria-label={props.firstLabel}
        placeholder={props.firstLabel}
        className="w-48"
        value={first}
        onChange={(event) => setFirst(event.target.value)}
      />
      <Input
        size="sm"
        aria-label={props.secondLabel}
        placeholder={props.secondLabel}
        className="min-w-48 flex-1"
        value={second}
        onChange={(event) => setSecond(event.target.value)}
      />
      <Button type="submit" size="sm" variant="outline" disabled={busy}>
        {props.submitLabel}
      </Button>
    </form>
  );
}

/** Lists one muted line per entry, or nothing. */
export function MutedLines(props: { lines: ReadonlyArray<string | null | undefined> }) {
  const lines = props.lines.filter((line): line is string => Boolean(line));
  if (lines.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

/** A choice from a short list and a submit button. */
export function PickForm(props: {
  label: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  submitLabel: string;
  onSubmit: (value: string) => Promise<boolean>;
}) {
  const [value, setValue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (props.options.length === 0) {
    return <p className="text-xs text-muted-foreground">Nothing to pick.</p>;
  }
  const picked = props.options.find((option) => option.value === value) ?? null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={value}
        onValueChange={(next) => {
          if (next === null) return;
          setValue(next as string);
        }}
      >
        <SelectTrigger aria-label={props.label} size="sm" className="w-56">
          <SelectValue>{picked?.label ?? props.label}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {props.options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <Button
        size="sm"
        variant="outline"
        disabled={busy || value === null}
        onClick={async () => {
          if (value === null) return;
          setBusy(true);
          await props.onSubmit(value);
          setBusy(false);
        }}
      >
        {props.submitLabel}
      </Button>
    </div>
  );
}
