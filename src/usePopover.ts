import { useEffect, useRef, useState } from "react";

export function usePopover<T extends HTMLElement = HTMLDivElement>() {
  const [open, setOpen] = useState(false);
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("textarea, input, select") && ref.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);
  return { open, setOpen, ref };
}
