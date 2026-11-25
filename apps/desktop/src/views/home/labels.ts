import type { TemplateInfo } from "@gamestudio/project";

/** What each template's engine is called on Home's template cards and in the New project dialog. */
export const ENGINE_LABEL: Record<TemplateInfo["engine"], string> = {
  godot: "Godot 4.7",
  "studio-board": "Plays in studio",
  "cpp-sfml": "C++ · SFML 3",
  unity: "Unity 6",
  unreal: "Unreal 5",
};
