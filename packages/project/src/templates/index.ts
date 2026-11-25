import type { GenerateOptions, GeneratedProject } from "./common";
import { generateOware } from "./oware";
import { generateAyo } from "./ayo";
import { generateNamnam } from "./namnam";
import { generateLudo } from "./ludo";
import { generatePlatformer } from "./platformer";
import { generateAdventure, generateExploration } from "./exploration";
import { generateFootball } from "./football";
import { generateFarm } from "./farm";
import { generateCreatures, generateLesson, generateSandbox } from "./foundations";
import { generateXr } from "./xr";
import { generateCpp } from "./cpp";
import { generateUnityExploration } from "./unity";
import { generateUnrealExploration, generateUnrealRealistic } from "./unreal";

export type TemplateStatus = "ready" | "foundation" | "planned";

export interface TemplateInfo {
  id: string;
  title: string;
  summary: string;
  category: "traditional" | "3d" | "rpg" | "education" | "logic" | "xr" | "arcade" | "sports" | "simulation";
  engine: "godot" | "studio-board" | "cpp-sfml" | "unity" | "unreal";
  status: TemplateStatus;
  /** Why a template is a foundation or still planned. */
  note?: string;
  generate?: (o: GenerateOptions) => GeneratedProject;
}

export const TEMPLATES: TemplateInfo[] = [
  { id: "oware-abapa", title: "Oware (Abapa)", summary: "The Ghanaian sowing game, Abapa variant, with sourced rules, a computer opponent and an editable rule graph.", category: "traditional", engine: "studio-board", status: "ready", generate: generateOware },
  { id: "oware-namnam", title: "Oware (Nam-nam)", summary: "Oware as Ghanaian children learn it: relay sowing, fours captured as they form, and rounds in which houses change hands until one player owns the board. Sourced rules, a computer opponent and an editable rule graph.", category: "traditional", engine: "studio-board", status: "ready", generate: generateNamnam },
  { id: "exploration-3d", title: "3D exploration: Sun Crystal Valley", summary: "Walk a small valley, talk to an elder, collect crystals and open a shrine gate. Godot project with a drag-and-drop layout.", category: "3d", engine: "godot", status: "ready", generate: generateExploration },
  { id: "adventure-3d", title: "3D adventure: Thornwood Ruins", summary: "Fight thorn beetles with your staff, push stone blocks onto pressure plates and light the beacon before the sunset timer runs out. Godot project with hearts, healing and the same drag-and-drop layout.", category: "3d", engine: "godot", status: "ready", generate: generateAdventure },
  { id: "exploration-unity", title: "3D exploration in Unity", summary: "The same valley as a Unity 6 project: the elder, the crystals and the shrine gate run on the same rules, in C#. Build a macOS app and run its self-test.", category: "3d", engine: "unity", status: "ready", generate: generateUnityExploration },
  { id: "exploration-unreal", title: "3D exploration in Unreal", summary: "The same valley as an Unreal Engine 5 project: the elder, the crystals and the shrine gate run on the same rules, in C++. Needs Xcode and its Metal toolchain; the first build takes several minutes.", category: "3d", engine: "unreal", status: "ready", generate: generateUnrealExploration },
  { id: "exploration-unreal-realistic", title: "3D exploration in Unreal: realistic people", summary: "The Unreal valley with a realistic person as the player: the motion-matching character from Epic's free Game Animation Sample (500+ motion-captured moves) wearing its MetaHuman, under Lumen light and volumetric clouds. Needs the sample from Fab in Documents/Unreal Projects; its 7 GB of content is copied into the project. The first build takes a long time.", category: "3d", engine: "unreal", status: "ready", generate: generateUnrealRealistic },
  { id: "logic-sandbox", title: "Visual logic sandbox", summary: "Learn events, variables, branches and loops in the rule editor and simulator.", category: "logic", engine: "studio-board", status: "ready", generate: generateSandbox },
  { id: "creature-collection", title: "Creature collection (foundation)", summary: "Original creature catalog with a deterministic encounter simulator.", category: "rpg", engine: "studio-board", status: "foundation", note: "No overworld, catching or quests yet.", generate: generateCreatures },
  { id: "science-lesson", title: "Science lesson (foundation)", summary: "Lesson objectives, concepts and a graded quiz with an evidence label.", category: "education", engine: "studio-board", status: "foundation", note: "Quiz only; no simulation scene yet.", generate: generateLesson },
  { id: "xr-foundation", title: "XR valley (foundation)", summary: "The 3D valley with OpenXR settings and an XR entry scene.", category: "xr", engine: "godot", status: "foundation", note: "Not verified on a headset. Gameplay rules run only in desktop mode.", generate: generateXr },
  { id: "cpp-sfml-arcade", title: "C++ arcade (SFML 3)", summary: "A small C++17 game with CMake, unit tests and a headless self-test, built and run from the studio.", category: "arcade", engine: "cpp-sfml", status: "foundation", note: "Needs CMake and SFML (brew install cmake sfml). Its game logic is plain C++; studio rule graphs do not drive it.", generate: generateCpp },
  { id: "ayo", title: "Ayò (Yoruba mancala)", summary: "The Yoruba sowing game with two-or-three captures, sourced rules (other accounts listed), an editable rule graph and a computer opponent.", category: "traditional", engine: "studio-board", status: "ready", generate: generateAyo },
  { id: "ludo", title: "Ludo", summary: "The dice race for 2 to 4 players with Classic rules, seeded dice that replay exactly, computer players and an editable rule graph.", category: "traditional", engine: "studio-board", status: "ready", generate: generateLudo },
  { id: "platformer-2d", title: "2D platformer: Sunset Cliffs", summary: "Run, jump and stomp through a side-scrolling Godot level with coins, checkpoints, a coin-locked gate and a side-view level editor.", category: "arcade", engine: "godot", status: "ready", generate: generatePlatformer },
  { id: "farm-sim", title: "Farm simulation: Sunrise Acres", summary: "Plant, water and harvest crops, sell them at the market stall and sleep to start each new day, with rain, market days and a money goal for the season. Godot project; the map, the crops, the farmer and the economy are settings.", category: "simulation", engine: "godot", status: "ready", generate: generateFarm },
  { id: "football", title: "Football: Harbour Cup Final", summary: "A five-a-side match against the computer on a walled pitch: run, pass, tackle and shoot, with keepers, a match clock and a golden goal when it is level. Godot project; teams, colours, pitch and difficulty are settings.", category: "sports", engine: "godot", status: "ready", generate: generateFootball },
];

export function templateById(id: string): TemplateInfo | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

export function generateProject(templateId: string, options: GenerateOptions): GeneratedProject {
  const template = templateById(templateId);
  if (!template) throw new Error(`Unknown template '${templateId}'`);
  if (!template.generate || template.status === "planned") throw new Error(`${template.title} is planned and cannot be created yet`);
  if (!options.title.trim()) throw new Error("Give the project a title");
  if (options.title.trim().length > 120) throw new Error("Project titles can be at most 120 characters");
  return template.generate(options);
}

export type { GenerateOptions, GeneratedProject, GeneratedFile } from "./common";
