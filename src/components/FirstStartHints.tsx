import { useEffect, useLayoutEffect, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { finishHints, hintsPending } from "../lib/firstHints.ts";
import { useT } from "../lib/i18n.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import "./FirstStartHints.css";

const storage = (): Storage | null => {
  try { return window.localStorage; } catch { return null; }
};

/** Each hint's anchor: the pane's Chat | Terminal switch, the sidebar's Agents section, its New workspace row. */
const ANCHORS = [".view-switch", ".agents-sidebar > .agent-section-toggle", ".machine-new-row"] as const;

const visible = (selector: string): HTMLElement | null => {
  const node = document.querySelector<HTMLElement>(selector);
  const box = node?.getBoundingClientRect();
  return node && box && box.width > 0 && box.height > 0 ? node : null;
};

/** where the card goes, and how far along its edge the arrow sits to point at the anchor's centre */
interface Place { top: number; left: number; side: "right" | "below"; arrow: number }

/** Beside an anchor in the left third of the window (the sidebar), under any other, kept inside the window. */
function placeBy(anchor: HTMLElement, width: number, height: number): Place {
  const box = anchor.getBoundingClientRect();
  const gap = 12;
  const clamp = (value: number, max: number) => Math.max(gap, Math.min(value, max - gap));
  if (box.left < window.innerWidth / 3) {
    const top = clamp(box.top + box.height / 2 - height / 2, window.innerHeight - height);
    return { side: "right", left: box.right + gap, top, arrow: box.top + box.height / 2 - top };
  }
  const left = clamp(box.left + box.width / 2 - width / 2, window.innerWidth - width);
  return { side: "below", top: box.bottom + gap, left, arrow: box.left + box.width / 2 - left };
}

/**
 * The three first-start hints, one small popover at a time, after the setup guide's first run started an agent
 * (lib/firstHints.ts): what Chat and Terminal are, where a waiting agent shows, how to start another. They wait
 * for the workspace's Chat | Terminal switch, skip an anchor this layout does not draw, and are done for good once
 * closed or seen through. Wide windows only: a phone's sidebar is a closed drawer. Nothing takes the keyboard from
 * the pane, and nothing is announced: a hint is there to be seen, and Next and the close button come after the
 * pane in the Tab order (the hint is drawn at the end of the page).
 */
export function FirstStartHints({ active }: { active: boolean }) {
  const t = useT();
  const [pending, setPending] = useState(() => { const store = storage(); return store !== null && hintsPending(store); });
  const [step, setStep] = useState(0);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [place, setPlace] = useState<Place | null>(null);
  const [card, setCard] = useState<HTMLElement | null>(null);
  const hints = [
    { title: t("Chat and Terminal show the same agent"), text: t("Terminal is the agent's real screen. Chat shows the same work as a conversation.") },
    { title: t("Agents that wait for you come first"), text: t("A waiting agent is marked here, whichever workspace it is in.") },
    { title: t("Start another agent"), text: t("A new workspace runs an agent in a folder you choose.") },
  ];
  const wide = useMediaQuery("(min-width: 641px)");
  const shown = active && pending && wide;
  const finish = (): void => {
    const store = storage();
    if (store !== null) finishHints(store);
    setPending(false);
  };
  usePhoneSheetBack(finish, shown && anchor !== null);

  // the hint at `step` or the next one this layout draws, once the workspace's switch is up; none left is the end.
  // Looked for again when its anchor went (re-rendered, or the layout changed)
  useEffect(() => {
    if (!shown || anchor !== null) return;
    const locate = (): boolean => {
      if (visible(ANCHORS[0]) === null) return false;
      for (let index = step; index < ANCHORS.length; index++) {
        const node = visible(ANCHORS[index]!);
        if (node !== null) { if (index !== step) setStep(index); setAnchor(node); return true; }
      }
      finish();
      return true;
    };
    if (locate()) return;
    // one look a frame, however much the page changes meanwhile (a terminal's output, a chat's stream)
    let frame = 0;
    const observer = new MutationObserver(() => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => { frame = 0; if (locate()) observer.disconnect(); });
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [shown, step, anchor]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    if (!shown || anchor === null || card === null) return;
    const measure = (): void => {
      // a replaced anchor measures nothing: the hint waits for the new one rather than go to the corner
      const box = anchor.getBoundingClientRect();
      if (!anchor.isConnected || box.width === 0 || box.height === 0) { setAnchor(null); setPlace(null); return; }
      setPlace(placeBy(anchor, card.offsetWidth, card.offsetHeight));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(anchor);
    observer.observe(card);
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, [shown, anchor, card]);

  if (!shown || anchor === null) return null;
  const hint = hints[step]!;
  const last = step === hints.length - 1;
  const next = (): void => { if (last) finish(); else { setAnchor(null); setPlace(null); setStep(step + 1); } };
  // at the end of the page, so its Next and close come after the pane in the Tab order
  return createPortal(
    <section ref={setCard} className={`first-hint is-${place?.side ?? "below"}`} role="dialog" aria-modal="false" aria-labelledby="first-hint-title"
      style={place === null ? { visibility: "hidden" } : { top: place.top, left: place.left, "--first-hint-arrow": `${Math.round(place.arrow)}px` } as CSSProperties}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); finish(); } }}>
      <h2 id="first-hint-title" className="first-hint-title">{hint.title}</h2>
      <p className="first-hint-text">{hint.text}</p>
      <div className="first-hint-foot">
        <span className="first-hint-count">{step + 1}/{hints.length}</span>
        <button type="button" className="btn btn-primary" onClick={next}>{last ? t("Done") : t("Next")}</button>
      </div>
      <button type="button" className="icon-button first-hint-close" aria-label={t("Close")} title={t("Close")} onClick={finish}><X aria-hidden="true" /></button>
    </section>,
    document.body,
  );
}
