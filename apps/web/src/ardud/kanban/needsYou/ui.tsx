/**
 * Small parts the Needs-you page is drawn from, in the board's own shapes:
 * pill buttons and chips, quiet fields, tokens from `tokens.css`.
 */
import { Dialog } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import {
  useLayoutEffect,
  useState,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../../../components/ui/tooltip";
import { observeResize } from "../../../lib/observeResize";
import { cn } from "../../../lib/utils";

const ring =
  "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)";

type BtnTone = "primary" | "plain" | "ghost";

/** The page's button: one filled primary per bar, plain and ghost for the rest. */
export function Btn({
  tone = "plain",
  size = "md",
  className,
  ...props
}: ComponentProps<"button"> & { tone?: BtnTone; size?: "sm" | "md" }) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-2 rounded-full font-medium whitespace-nowrap transition-[background-color,opacity,transform] duration-150 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50 disabled:active:translate-y-0 [&_svg]:size-4 [&_svg]:shrink-0",
        size === "sm"
          ? "h-7.5 px-3 text-sm pointer-coarse:h-9"
          : "h-9 px-4 text-sm pointer-coarse:h-11 pointer-coarse:text-base",
        tone === "primary" && "bg-(--m-accent) text-(--m-accent-ink) hover:opacity-90",
        tone === "plain" && "bg-(--m-chip) text-(--m-text) hover:bg-(--m-active)",
        tone === "ghost" && "text-(--m-muted) hover:bg-(--m-chip) hover:text-(--m-text)",
        ring,
        // On the accent fill the ring is the fill's own ink, set in from the edge.
        tone === "primary" &&
          "focus-visible:ring-0 focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-(--m-accent-ink) focus-visible:outline-solid",
        size === "sm" && "relative pointer-coarse:after:absolute pointer-coarse:after:-inset-1",
        className,
      )}
    />
  );
}

export function IconBtn({
  label,
  className,
  ...props
}: Omit<ComponentProps<"button">, "aria-label"> & { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            {...props}
            className={cn(
              "grid size-8 shrink-0 place-items-center rounded-full text-(--m-muted) hover:bg-(--m-chip) hover:text-(--m-text) disabled:opacity-40 disabled:hover:bg-transparent pointer-coarse:size-11 [&_svg]:size-4",
              ring,
              className,
            )}
          />
        }
      />
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

/** A key cap. Hidden where there is no keyboard to press it on. */
export function Key({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-grid h-5 min-w-5 place-items-center rounded-md px-1 font-sans text-xs font-medium text-(--m-muted) ring-1 ring-inset ring-(--m-control) pointer-coarse:hidden",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

type PillTone = "plain" | "warn" | "accent" | "negative";

/** A small state label inside a row or beside a title. */
export function Pill({
  tone = "plain",
  className,
  children,
}: {
  tone?: PillTone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5.5 shrink-0 items-center gap-1.5 rounded-full px-2.25 text-xs font-medium whitespace-nowrap [&_svg]:size-3",
        tone === "plain" && "bg-(--m-chip) text-(--m-text)",
        tone === "warn" && "bg-(--ny-warnband) text-(--m-warning)",
        tone === "accent" && "bg-(--m-band) text-(--m-accent-text)",
        tone === "negative" && "bg-(--ny-negband) text-(--m-negative)",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** A filter chip: pressed or not. */
export function FilterChip({
  pressed,
  className,
  ...props
}: ComponentProps<"button"> & { pressed: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      {...props}
      className={cn(
        "relative inline-flex h-7.5 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm whitespace-nowrap pointer-coarse:h-9 pointer-coarse:after:absolute pointer-coarse:after:-inset-1",
        pressed
          ? "bg-(--m-chip) font-medium text-(--m-text)"
          : "text-(--m-muted) hover:bg-(--m-chip) hover:text-(--m-text)",
        ring,
        className,
      )}
    />
  );
}

/** Classes for a text input, textarea or select. */
export const fieldClass =
  "block w-full min-w-0 rounded-xl bg-(--m-ground) px-3 py-2 text-sm leading-5 text-(--m-text) ring-1 ring-inset ring-(--ny-edge) outline-none placeholder:text-(--m-muted) focus:ring-2 focus:ring-(--m-accent) aria-invalid:ring-(--m-negative) pointer-coarse:text-base";

/** A quiet text link. */
export const linkClass =
  "relative rounded font-medium text-(--m-accent-text) underline-offset-3 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent) pointer-coarse:after:absolute pointer-coarse:after:-inset-x-2 pointer-coarse:after:-inset-y-3";

/** A grey bar that holds the place of a value while it loads. */
export function Bar({ className }: { className?: string }) {
  return <span aria-hidden className={cn("block rounded-md bg-(--m-chip)", className)} />;
}

/** A small label above a group of facts or a block. */
export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("text-xs text-(--m-muted)", className)}>{children}</div>;
}

export type LayerSide = "right" | "bottom" | "center";

/**
 * A sheet over the page: from the right on a wide screen, from the bottom on a
 * phone, or centred. Focus stays inside it and Escape closes it.
 */
export function Layer(props: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Shown beside the title, muted. */
  meta?: ReactNode;
  side: LayerSide;
  /** Fills the height it may take, instead of fitting its content. */
  tall?: boolean;
  wide?: boolean;
  /** Stops short of the bottom by this many px, so what is under it stays in reach. */
  bottomOffset?: number;
  footer?: ReactNode;
  /** What is inside brings its own title and Close: the sheet draws no header. */
  bare?: boolean;
  bodyClassName?: string;
  initialFocus?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const { side } = props;
  const offset = props.bottomOffset ?? 0;
  return (
    <Dialog.Root
      open={props.open}
      onOpenChange={(open) => !open && props.onClose()}
      modal={offset > 0 ? "trap-focus" : true}
    >
      <Dialog.Portal>
        <Dialog.Backdrop
          className={cn(
            "fixed inset-x-0 top-0 bg-black/25 transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none",
            side === "center" ? "z-50" : "z-(--z-sheet)",
          )}
          style={{ bottom: offset }}
        />
        <Dialog.Popup
          initialFocus={props.initialFocus}
          aria-label={props.title}
          data-ny
          className={cn(
            "fixed flex min-h-0 flex-col bg-(--m-raised) text-(--m-text) shadow-xl ring-1 ring-(--m-rule) outline-none transition-[opacity,translate] duration-200 ease-out data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none",
            side === "right" &&
              "inset-y-0 right-0 w-full max-w-[480px] data-ending-style:translate-x-6 data-starting-style:translate-x-6",
            side === "bottom" &&
              "inset-x-0 max-h-[88dvh] rounded-t-2xl pb-safe data-ending-style:translate-y-8 data-starting-style:translate-y-8",
            side === "bottom" && props.tall && "h-[88dvh]",
            side === "center" ? "z-50" : "z-(--z-sheet)",
            side === "center" &&
              "top-1/2 left-1/2 max-h-[84dvh] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-2xl",
            side === "center" && (props.wide ? "max-w-[1040px]" : "max-w-[520px]"),
            side === "center" && props.tall && "h-[84dvh]",
          )}
          style={
            side === "bottom"
              ? {
                  bottom: offset,
                  ...(offset > 0 && props.tall ? { height: `calc(88dvh - ${offset}px)` } : {}),
                }
              : undefined
          }
        >
          {props.bare ? (
            <Dialog.Title className="sr-only">{props.title}</Dialog.Title>
          ) : (
            <header className="flex shrink-0 items-center gap-2 border-b border-(--m-rule) py-2.5 ps-5 pe-2.5">
              <Dialog.Title className="min-w-0 flex-1 truncate text-base font-semibold">
                {props.title}
              </Dialog.Title>
              {props.meta ? (
                <span className="shrink-0 text-sm text-(--m-muted) tabular-nums">{props.meta}</span>
              ) : null}
              <Dialog.Close render={<IconBtn label="Close" />}>
                <XIcon />
              </Dialog.Close>
            </header>
          )}
          <div
            className={cn(
              "min-h-0 flex-1 overflow-y-auto overscroll-contain p-5",
              props.bodyClassName,
            )}
          >
            {props.children}
          </div>
          {props.footer ? (
            <footer className="flex shrink-0 justify-end gap-2 border-t border-(--m-rule) px-5 py-3">
              {props.footer}
            </footer>
          ) : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export type PageLayout = "phone" | "tablet" | "desktop";

/**
 * Which composition the page takes, from the width it actually has (the app's
 * own sidebar may be open or folded): one pane on a phone, two on a tablet,
 * two plus the facts column on a desktop.
 */
export function usePageLayout(ref: RefObject<HTMLElement | null>): PageLayout {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.clientWidth);
    return observeResize(element, ([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
  }, [ref]);
  if (width === null) return "desktop";
  return width < 700 ? "phone" : width < 1000 ? "tablet" : "desktop";
}
