import type { MouseEvent } from "react";

const OPEN_PULL_REQUEST_EVENT = "bb-pull-requests:open";

export function openPullRequestInPanel(event: MouseEvent<HTMLElement>, url: string): void {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const request = new CustomEvent(OPEN_PULL_REQUEST_EVENT, { bubbles: true, cancelable: true, detail: { url } });
  if (event.currentTarget.dispatchEvent(request)) return;
  event.preventDefault();
  event.stopPropagation();
}
