import { useEffect, useRef } from "react";
import { EditorView, basicSetup } from "codemirror";
import { EditorState, Compartment } from "@codemirror/state";
import { json } from "@codemirror/lang-json";
import { StreamLanguage, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { python } from "@codemirror/legacy-modes/mode/python";
import { cpp, csharp } from "@codemirror/legacy-modes/mode/clike";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { cmake } from "@codemirror/legacy-modes/mode/cmake";
import { tags as t } from "@lezer/highlight";

const theme = EditorView.theme(
  {
    "&": { height: "100%", backgroundColor: "var(--bg-0)", color: "var(--text-1)", fontSize: "12.5px" },
    ".cm-content": { fontFamily: "var(--font-mono)", caretColor: "var(--accent-2)" },
    ".cm-gutters": { backgroundColor: "var(--bg-1)", color: "var(--text-4)", border: "none", borderRight: "1px solid var(--line)" },
    ".cm-activeLine": { backgroundColor: "rgba(255,255,255,0.025)" },
    ".cm-activeLineGutter": { backgroundColor: "var(--bg-2)", color: "var(--text-2)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "rgba(56,201,180,0.25) !important" },
    ".cm-cursor": { borderLeftColor: "var(--accent-2)" },
    ".cm-scroller": { overflow: "auto" },
    ".cm-searchMatch": { backgroundColor: "rgba(239,176,74,0.3)" },
    ".cm-panels": { backgroundColor: "var(--bg-2)", color: "var(--text-1)" },
  },
  { dark: true },
);

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword], color: "#c6b6ff" },
  { tag: [t.string, t.special(t.string)], color: "#9de8bd" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "#ffd28a" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#5f718b", fontStyle: "italic" },
  { tag: [t.propertyName, t.attributeName], color: "#8ec5ff" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#7fe0d0" },
  { tag: [t.typeName, t.className], color: "#f5b7c8" },
  { tag: [t.meta, t.processingInstruction], color: "#ffb38a" },
  { tag: t.heading, color: "#e8eef7", fontWeight: "600" },
]);

export function languageLabel(path: string): string {
  if (path.endsWith(".json") || path.endsWith(".uproject")) return "JSON";
  if (path.endsWith(".ini")) return "INI";
  if (path.endsWith(".gd")) return "GDScript (Python-style highlighting)";
  if (/\.(cpp|hpp|h|cc)$/.test(path)) return "C++";
  if (path.endsWith(".cs")) return "C#";
  if (/CMakeLists\.txt$|\.cmake$/.test(path)) return "CMake";
  if (/\.(tscn|godot|tres|cfg|import)$/.test(path)) return "Godot / INI";
  return "Plain text";
}

function languageFor(path: string) {
  if (path.endsWith(".json") || path.endsWith(".uproject")) return json();
  if (path.endsWith(".ini")) return StreamLanguage.define(properties);
  if (path.endsWith(".gd")) return StreamLanguage.define(python);
  if (/\.(cpp|hpp|h|cc)$/.test(path)) return StreamLanguage.define(cpp);
  if (path.endsWith(".cs")) return StreamLanguage.define(csharp);
  if (/CMakeLists\.txt$|\.cmake$/.test(path)) return StreamLanguage.define(cmake);
  if (/\.(tscn|godot|tres|cfg|import)$/.test(path)) return StreamLanguage.define(properties);
  return [];
}

/** CodeMirror 6 editor. The document text is owned by the caller; external changes replace the content. */
export function CodeEditor({ path, value, version, onChange, readOnly }: { path: string; value: string; version: number; onChange?: (text: string) => void; readOnly?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const change = useRef(onChange);
  change.current = onChange;
  const editable = useRef(new Compartment());

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          theme,
          syntaxHighlighting(highlight),
          languageFor(path),
          EditorView.lineWrapping,
          editable.current.of(EditorState.readOnly.of(Boolean(readOnly))),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) change.current?.(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
    // Recreate only when a different file is shown.
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [version]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    view.current?.dispatch({ effects: editable.current.reconfigure(EditorState.readOnly.of(Boolean(readOnly))) });
  }, [readOnly]);

  return <div ref={host} style={{ height: "100%", overflow: "hidden" }} data-testid="code-editor" />;
}
