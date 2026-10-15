/**
 * monaco/ghost-layer.ts — ghost-text-lagret i Monaco.
 *
 * Monacos publika API har ingen "after content"-dekoration, så lagret är en
 * IContentWidget med position EXACT vid cursorns position — det ger inline-läge utan att
 * rör buffer­innehållet. Multi-line-förslag visar första raden inline plus en badge med
 * antal ytterligare rader; Tab sätter in HELA förslaget.
 *
 * Tangentbindningar:
 *   Tab      — acceptera (bara när ghost syns och sugestionslistan är stängd)
 *   Escape   — avvisa
 *   annat    — content/cursor-change i editorn aviserar (se controller hooks)
 */
import * as monaco from "monaco-editor";
import type { ICodeEditor, IContentWidget, IContentWidgetPosition } from "monaco-editor";
import type { ModelSource } from "@nexus/protocol";

export interface GhostMeta {
  readonly model: string;
  readonly latencyMs: number;
  readonly source: ModelSource;
  readonly cached: boolean;
}

export interface GhostControllerHooks {
  onAccept(text: string): void;
  onDismiss(reason: "escape" | "moved" | "typing" | "blur"): void;
}

export interface GhostController {
  show(text: string, position: { line: number; column: number }, meta: GhostMeta): void;
  clear(): void;
  readonly visible: boolean;
  dispose(): void;
}

const WIDGET_ID = "nexus.ghostText";
const CONTEXT_KEY = "nexusGhostVisible";

class GhostWidget implements IContentWidget {
  private readonly node: HTMLElement;
  private readonly inlineSpan: HTMLElement;
  private readonly badge: HTMLElement;
  private position: IContentWidgetPosition | null = null;

  constructor() {
    this.node = document.createElement("div");
    this.node.className = "nx-ghost-widget";
    this.node.setAttribute("aria-hidden", "true");
    this.inlineSpan = document.createElement("span");
    this.inlineSpan.className = "nx-ghost-text";
    this.badge = document.createElement("span");
    this.badge.className = "nx-ghost-badge";
    this.node.append(this.inlineSpan, this.badge);
  }

  getId(): string {
    return WIDGET_ID;
  }

  getDomNode(): HTMLElement {
    return this.node;
  }

  getPosition(): IContentWidgetPosition | null {
    return this.position;
  }

  set(text: string, restLines: number, meta: GhostMeta, line: number, column: number): void {
    this.inlineSpan.textContent = text;
    const bits: string[] = [];
    if (restLines > 0) bits.push(`+${restLines} rad${restLines === 1 ? "" : "er"}`);
    if (meta.latencyMs > 0) bits.push(`${meta.latencyMs} ms`);
    if (meta.model) bits.push(meta.model);
    if (meta.cached) bits.push("cache");
    this.badge.textContent = bits.length > 0 ? ` ${bits.join(" · ")}` : "";
    this.position = {
      position: { lineNumber: line, column },
      preference: [monaco.editor.ContentWidgetPositionPreference.EXACT],
    };
  }

  hide(): void {
    this.position = null;
    this.inlineSpan.textContent = "";
    this.badge.textContent = "";
  }
}

export function createGhostController(
  editor: ICodeEditor,
  hooks: GhostControllerHooks,
): GhostController {
  const widget = new GhostWidget();
  editor.addContentWidget(widget);

  const visibleKey = editor.createContextKey<boolean>(CONTEXT_KEY, false);
  const when = `${CONTEXT_KEY} == true && suggestWidgetVisible == false`;
  const whenNoSuggest = `${CONTEXT_KEY} == true && suggestWidgetVisible == false`;

  let ghostText = "";
  let disposed = false;

  type InternalReason = "accept" | "escape" | "moved" | "typing" | "blur" | "external";

  function hide(reason: InternalReason): void {
    if (ghostText.length === 0) return;
    ghostText = "";
    widget.hide();
    editor.layoutContentWidget(widget);
    visibleKey.set(false);
    if (reason !== "accept") hooks.onDismiss(reason === "external" ? "blur" : reason);
  }

  // Monaco returnerar null om bindingen redan finns; det är ofarligt här.
  editor.addCommand(monaco.KeyCode.Tab, () => {
    const text = ghostText;
    if (text.length === 0) return;
    hide("accept");
    hooks.onAccept(text);
  }, when);

  editor.addCommand(monaco.KeyCode.Escape, () => {
    if (ghostText.length === 0) return;
    hide("escape");
  }, whenNoSuggest);

  const contentSub = editor.onDidChangeModelContent(() => {
    // Användaren skrev (eller vi accepterade): föråldra omedelbart.
    hide("typing");
  });

  const cursorSub = editor.onDidChangeCursorPosition(() => {
    hide("moved");
  });

  const blurSub = editor.onDidBlurEditorText(() => {
    hide("blur");
  });

  return {
    get visible(): boolean {
      return ghostText.length > 0;
    },
    show(text, position, meta): void {
      if (disposed) return;
      if (text.length === 0) {
        hide("external");
        return;
      }
      ghostText = text;
      const lines = text.split("\n");
      const first = lines[0] ?? "";
      const rest = Math.max(0, lines.length - 1);
      widget.set(first, rest, meta, position.line, position.column);
      editor.layoutContentWidget(widget);
      visibleKey.set(true);
    },
    clear(): void {
      hide("external");
    },
    dispose(): void {
      disposed = true;
      hide("external");
      editor.removeContentWidget(widget);
      visibleKey.set(false);
      contentSub.dispose();
      cursorSub.dispose();
      blurSub.dispose();
    },
  };
}

/** Insättning av ghost-text i en editor —returnerar new selection position. */
export function insertGhostText(editor: ICodeEditor, text: string): void {
  const position = editor.getPosition();
  if (!position) return;
  const selection = editor.getSelection();
  if (!selection) return;
  editor.executeEdits("nexus.ghost", [
    { range: selection, text, forceMoveMarkers: true },
  ]);
  editor.focus();
}
