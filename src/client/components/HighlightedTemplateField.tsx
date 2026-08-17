import {
  forwardRef,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { cn } from "@/client/lib/utils";

// Generic template field with inline {{token}} highlighting, via the classic transparent-control-
// over-colored-backdrop overlay: the editable control (on top) owns caret/selection with transparent
// text; the backdrop (behind) shows the same text with the tokens colored; scroll is mirrored so the
// layers stay aligned. The token pattern and the "is this a known token?" predicate are injected, so
// the same component serves the prompt editor (lowercase prompt vars) and the HTTP tool editor
// (AI fields + context vars + {{secret}}). Renders a <textarea> when `multiline`, else an <input>.

function renderHighlighted(
  text: string,
  patternSource: string,
  isKnown: (name: string) => boolean,
): ReactNode[] {
  const re = new RegExp(patternSource, "g");
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    const known = isKnown(m[1] ?? "");
    out.push(
      <span
        key={key++}
        className={cn(
          known
            ? "font-semibold text-accent"
            : "text-warning underline decoration-wavy",
        )}
      >
        {m[0]}
      </span>,
    );
    last = idx + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  if (text.endsWith("\n")) out.push(" ");
  return out;
}

// Rigidly synchronized box model and typography tokens between the backdrop and the editable control.
// Strict font-family, exact line-height (leading-6 / 24px) and whitespace rules prevent font desync
// or line-height drift where letters stack on top of each other.
const FIELD_BASE =
  "tab-2 m-0 block w-full rounded-lg border box-border font-mono text-sm leading-6 tracking-normal";

export const HighlightedTemplateField = forwardRef<
  HTMLInputElement | HTMLTextAreaElement,
  {
    value: string;
    onChange: (value: string) => void;
    isKnownToken: (name: string) => boolean;
    patternSource: string;
    multiline?: boolean;
    rows?: number;
    placeholder?: string;
    invalid?: boolean;
    fill?: boolean;
    className?: string;
    textClassName?: string;
    "aria-label"?: string;
  }
>(
  (
    {
      value,
      onChange,
      isKnownToken,
      patternSource,
      multiline = false,
      rows = 6,
      placeholder,
      invalid = false,
      fill = false,
      className,
      textClassName,
      "aria-label": ariaLabel,
    },
    ref,
  ) => {
    const backdropRef = useRef<HTMLDivElement>(null);
    const controlRef = useRef<
      HTMLInputElement | HTMLTextAreaElement | null
    >(null);

    const pad = multiline ? "p-3" : "px-4 py-2";
    const wrapCls = multiline
      ? "whitespace-pre-wrap break-words overflow-x-hidden"
      : "whitespace-pre overflow-x-auto";

    const mirrorScroll = useCallback((el: HTMLElement) => {
      const b = backdropRef.current;
      if (!b) return;
      b.scrollTop = el.scrollTop;
      b.scrollLeft = el.scrollLeft;
    }, []);

    const sharedText = cn(FIELD_BASE, pad, wrapCls, textClassName);

    // Keep internal and forwarded refs unified
    const setRefs = (el: HTMLInputElement | HTMLTextAreaElement | null) => {
      controlRef.current = el;
      if (typeof ref === "function") {
        ref(el);
      } else if (ref && "current" in ref) {
        (
          ref as React.MutableRefObject<
            HTMLInputElement | HTMLTextAreaElement | null
          >
        ).current = el;
      }
    };

    useEffect(() => {
      if (controlRef.current) {
        mirrorScroll(controlRef.current);
      }
    }, [mirrorScroll, value]);

    return (
      <div
        className={cn(
          "relative min-w-0 rounded-lg bg-bg-tertiary",
          fill && "h-full min-h-0 flex-1",
          className,
        )}
      >
        {/* Backdrop (rendered behind with highlighted tokens) */}
        <div
          ref={backdropRef}
          aria-hidden="true"
          className={cn(
            sharedText,
            "pointer-events-none absolute inset-0 select-none overflow-y-auto border-transparent text-text-primary",
            fill ? "h-full" : "h-full",
          )}
          style={{
            scrollbarWidth: "none",
            msOverflowStyle: "none",
          }}
        >
          {renderHighlighted(value, patternSource, isKnownToken)}
        </div>

        {/* Editable input / textarea (on top with transparent text and visible caret) */}
        {multiline ? (
          <textarea
            ref={setRefs as Ref<HTMLTextAreaElement>}
            rows={rows}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onScroll={(e) => mirrorScroll(e.currentTarget)}
            spellCheck={false}
            placeholder={placeholder}
            aria-label={ariaLabel}
            style={{
              color: "transparent",
              WebkitTextFillColor: "transparent",
              caretColor: "var(--color-text-primary)",
            }}
            className={cn(
              sharedText,
              "relative bg-transparent placeholder-text-placeholder selection:bg-accent/30 selection:text-transparent focus:border-border-focus focus:outline-none",
              fill ? "h-full resize-none" : "min-h-[140px] resize-y",
              invalid ? "border-error" : "border-border",
            )}
          />
        ) : (
          <input
            ref={setRefs as Ref<HTMLInputElement>}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onScroll={(e) => mirrorScroll(e.currentTarget)}
            spellCheck={false}
            placeholder={placeholder}
            aria-label={ariaLabel}
            style={{
              color: "transparent",
              WebkitTextFillColor: "transparent",
              caretColor: "var(--color-text-primary)",
            }}
            className={cn(
              sharedText,
              "relative bg-transparent placeholder-text-placeholder selection:bg-accent/30 selection:text-transparent focus:border-border-focus focus:outline-none",
              invalid ? "border-error" : "border-border",
            )}
          />
        )}
      </div>
    );
  },
);

HighlightedTemplateField.displayName = "HighlightedTemplateField";
