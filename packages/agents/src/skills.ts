import type { OperationKind } from "./operations";

/**
 * Skill registry, following the blueprint's contract (skill_id, version, inputs, tools_allowed,
 * permissions, validation, rollback, max_retries_per_operation). A skill grants operations to an
 * agent and adds instructions; it never grants file, process or network access.
 */
export interface SkillDef {
  id: string;
  version: string;
  title: string;
  inputs: string[];
  toolsAllowed: OperationKind[];
  permissions: ("read_project" | "project_scoped_write")[];
  validation: string[];
  rollback: "git_snapshot" | "none";
  maxRetriesPerOperation: 2;
  instructions: string;
}

export const SKILLS: SkillDef[] = [
  {
    id: "edit_world_layout",
    version: "1.0.0",
    title: "Edit the exploration world layout",
    inputs: ["world_layout"],
    toolsAllowed: ["world.add", "world.move", "world.remove", "world.set", "world.environment", "world.player", "world.character", "world.audio"],
    permissions: ["read_project", "project_scoped_write"],
    validation: ["world_schema_valid", "objects_inside_map", "unique_ids"],
    rollback: "git_snapshot",
    maxRetriesPerOperation: 2,
    instructions:
      "Coordinates are metres on the ground: x grows to the east (right), z grows to the south (towards the player start). " +
      "Keep every object inside the map bounds. New ids are lowercase with underscores, for example tree_7 or crystal_4. " +
      "Collectibles count towards the rules by their kind; keep kind 'crystal' unless asked otherwise. Colours are #rrggbb. " +
      "Imported 3D models are objectType 'model' with an 'asset' attribute naming one of the listed model files (and optional 'collide' true or false); never invent a file name. " +
      "Models come in their own units, so scale may range from 0.01 to 100. world.environment quality is 'standard' or 'high' (desktop builds only); groundTexture names a listed texture file, or '' for the plain ground colour; sunColor is the sunlight's #rrggbb colour (warm for evening); clouds (0 clear to 1 overcast), groundVariation (0 even to 1 patchy), grass (0 none to 1 thick), style ('standard', 'anime' for toon shading with ink outlines, or 'realistic' for detailed trees and rocks and filmic light), skyImage (a listed photographed sky file, or '' for the sky colours and clouds) and skyBrightness (0.1 to 4) are drawn in Godot projects only. " +
      "Characters: world.character sets the player's character (asset first, then height in metres, turn in degrees, and the idle, walk, run and jump animation names; asset '' goes back to the capsule). A villager (npc) can use a listed model with world.set model, height and animation; a model object can loop an animation. Use only animation names listed for that model. " +
      "Textures: world.set texture puts a listed texture file on a tree, rock, gate, sign or torch ('' removes it); textureTile is how many metres one repeat covers; tint true keeps the object's own colours over the texture. " +
      "Sound: world.audio sets the looping music (a listed sound file, or '' for none), musicVolume (0 to 1), or replaces a built-in sound (chime, gate, success, error) with a listed file ('' goes back to the built-in one). " +
      "Adventure pieces (Godot projects only): an 'enemy' wanders within roam metres of its spot, chases the player within sight metres at speed metres per second (0 stands guard), costs damage hearts on touch and needs health hits from the player's staff; give enemies a kind such as 'beetle' (rules count them by kind), a name and a #rrggbb color, or a listed model and height. " +
      "A 'crate' is a block the player pushes by walking into it (variant 'wood' or 'stone', 1.2 m across at scale 1); rules hear when one is pushed into a zone, so put plates (small zones) where blocks should go and leave a clear straight path to push along. " +
      "world.player health sets the hearts the player starts with (1 to 20, 3 when unset). Keep enemies away from the player's spawn point, more than their sight from it. " +
      "Villagers (npc) can answer what players type, with AI, while the game plays inside Game Studio: world.set persona (who they are and how they talk, up to 600 characters) and knows (what they can tell the player, up to 1200 characters; '' for both turns it off). Exported games show the rules' written lines instead.",
  },
  {
    id: "edit_farm",
    version: "1.0.0",
    title: "Edit a farm simulation's settings, crops and map",
    inputs: ["farm_settings"],
    toolsAllowed: ["farm.set", "farm.crop", "farm.addCrop", "farm.removeCrop", "farm.fill"],
    permissions: ["read_project", "project_scoped_write"],
    validation: ["farm_schema_valid"],
    rollback: "git_snapshot",
    maxRetriesPerOperation: 2,
    instructions:
      "farm.set changes the farm: name, farmerName (up to 24 characters), shirt (#rrggbb), currency (what money is called, up to 12 characters), startMoney (whole number), dayLength (20 to 900 seconds of play a day), rainChance (0 to 1), spawnX and spawnY (the farmer's start tile, which must be walkable), width (8 to 40) and height (6 to 30) of the map in tiles (new tiles are grass). " +
      "farm.addCrop adds a crop with an id (lowercase letters, digits, underscores; rules name crops by it) and a name, with standard numbers you can then change; farm.crop changes a crop's name, seedCost, days (1 to 30 days to grow), yield (1 to 20 per tile), price (what one sells for), color (#rrggbb), needsWater (true or false) or regrow (days to grow again after harvest, 0 for once); farm.removeCrop removes one (at least one must stay, and rules may name it). A farm holds up to 8 crops. " +
      "farm.fill paints a rectangle of the map with one tile: x and y are the top-left tile (x from 0 at the left, y from 0 at the top), width and height in tiles, tile one of grass, soil (the only tiles crops grow on), path, water, tree, fence (water, trees and fences block walking), house (sleep to start the next day) and market (the stall that buys the harvest). Keep exactly one house and one market area, plenty of soil, a walkable way between them, and trees or fences round the edge. " +
      "Money goals, market days and the end of the season are rules, which are the Rules Engineer's.",
  },
  {
    id: "edit_match_settings",
    version: "1.0.0",
    title: "Edit a football match's settings",
    inputs: ["match_settings"],
    toolsAllowed: ["match.set", "match.team", "match.player"],
    permissions: ["read_project", "project_scoped_write"],
    validation: ["match_schema_valid"],
    rollback: "git_snapshot",
    maxRetriesPerOperation: 2,
    instructions:
      "match.set changes the match: name (text), teamSize (players a side, 2 to 5, the keeper included), minutes (1 to 20, of play), difficulty ('easy', 'normal' or 'hard': how quick and sharp the computer's team is), control (the side the player controls: 'home', 'away', or 'none' to watch the computer play both), " +
      "pitchLength (24 to 70 m), pitchWidth (14 to 45 m), goalWidth (2 to 7.5 m, and at least 6 m narrower than the pitch), grass and lines (#rrggbb colours), stripes (true or false). " +
      "match.team changes one team: team 'home' is the player's, 'away' the computer's; name (up to 40 characters), short (2 to 4 capital letters or digits, different from the other team's, shown on the scoreboard), shirt, shorts and keeper (#rrggbb colours; keep the two teams' shirts easy to tell apart). " +
      "match.player changes one squad member: team, slot (1 to 5; slot 1 keeps goal, and a side of N players fields slots 1 to N), and name (up to 24 characters), number (shirt number 1 to 99, unique in the team), pace, shooting or tackling (whole numbers 1 to 10; 5 is standard). Use original names, never real footballers'. " +
      "The pitch is walled, so there are no throw-ins, corners or offside; rules (goals, full time, extra time) are the Rules Engineer's.",
  },
  {
    id: "edit_platformer_level",
    version: "1.0.0",
    title: "Edit a 2D platformer level",
    inputs: ["platformer_level"],
    toolsAllowed: ["level.add", "level.move", "level.remove", "level.set", "level.settings", "level.sprite", "level.audio"],
    permissions: ["read_project", "project_scoped_write"],
    validation: ["level_schema_valid", "objects_inside_level", "unique_ids", "has_goal", "reach_warnings"],
    rollback: "git_snapshot",
    maxRetriesPerOperation: 2,
    instructions:
      "Units are tiles: x grows to the right from the level's left edge, y grows upwards from the bottom. A platform's (x, y) is its bottom-left corner and its top is at y + height; every other object stands on its (x, y), so put it on a platform top. " +
      "The player jumps jumpHeight tiles at most: keep every step up from one platform to the next at or below that, and gaps across at most about 5 tiles. Coins may hang up to jumpHeight + 1 above a surface. " +
      "Wooden platforms (style 'wood') can be jumped through from below. Spikes hurt; enemies (beetles) patrol range tiles each way and are stomped by jumping on them. The level needs one goal flag; a door blocks the way until the rules open it. Coins count by kind (keep 'coin' unless asked). " +
      "New ids are lowercase with underscores, for example ledge_9 or coin_12. Colours are #rrggbb. " +
      "level.sprite draws the player from a listed sprite sheet: asset first, then columns and rows of equal frames (numbered from 0, left to right, top to bottom), the idle, run and jump frame lists, fps, height in tiles and facing ('right' or 'left', the way the frames look); asset '' goes back to the drawn runner. " +
      "level.set texture tiles a listed picture over a platform ('' goes back to the style's drawing) and tile is how many tiles one repeat covers. " +
      "level.audio sets the looping music (a listed sound file, or '' for none), musicVolume (0 to 1), or replaces a built-in sound (coin, jump, checkpoint, door, hurt, stomp, success) with a listed file ('' goes back to the built-in one).",
  },
  {
    id: "edit_rule_graph",
    version: "1.0.0",
    title: "Edit visual rule graphs",
    inputs: ["rule_graphs", "node_palette"],
    toolsAllowed: ["rules.addNode", "rules.removeNode", "rules.setParam", "rules.connect", "rules.disconnect", "rules.addVariable"],
    permissions: ["read_project", "project_scoped_write"],
    validation: ["graph_schema_valid", "typed_connections", "no_execution_cycles", "domain_rules"],
    rollback: "git_snapshot",
    maxRetriesPerOperation: 2,
    instructions:
      "Use only node types from the palette. Pins are written kind:name, for example exec:out, exec:in, data:pit or data:result. " +
      "An exec output connects to exactly one node; use a Sequence node to run several. Data inputs accept one connection. " +
      "Prefer changing a setting with rules.setParam over rebuilding nodes. Give new nodes positions near related nodes.",
  },
  {
    id: "design_original_creatures",
    version: "1.0.0",
    title: "Design original creatures",
    inputs: ["creature_catalog"],
    toolsAllowed: ["creatures.add", "creatures.set"],
    permissions: ["read_project", "project_scoped_write"],
    validation: ["catalog_schema_valid", "original_content_declared"],
    rollback: "git_snapshot",
    maxRetriesPerOperation: 2,
    instructions:
      "Every creature must be original: never reuse names, designs, moves or lore from existing franchises such as Pokémon, Digimon or Monster Hunter. " +
      "Stats are whole numbers from 1 to 255; move power is a whole number from 10 to 120. Elements: plain, sun, river, forest.",
  },
  {
    id: "write_lesson_questions",
    version: "1.0.0",
    title: "Write lesson questions",
    inputs: ["lesson"],
    toolsAllowed: ["lesson.addQuestion"],
    permissions: ["read_project", "project_scoped_write"],
    validation: ["lesson_schema_valid", "answer_in_options"],
    rollback: "git_snapshot",
    maxRetriesPerOperation: 2,
    instructions:
      "Questions must follow from the lesson's own concepts and evidence label. Never claim a value is validated or clinically accurate. " +
      "For single-choice questions, 'answer' is the zero-based index of the correct option and tolerance is 0 with an empty unit. " +
      "For numeric questions, options is empty, and give a realistic tolerance and unit.",
  },
  {
    id: "review_ruleset_provenance",
    version: "1.0.0",
    title: "Review rules, variants and sources",
    inputs: ["rule_graphs", "provenance"],
    toolsAllowed: [],
    permissions: ["read_project"],
    validation: ["no_changes"],
    rollback: "none",
    maxRetriesPerOperation: 2,
    instructions:
      "Read-only review. Return an empty operations list and write findings in the summary. Comment only on what the project's own " +
      "documents and listed sources support. Never invent historical, cultural or regional provenance; say what is undocumented.",
  },
  {
    id: "describe_project",
    version: "1.0.0",
    title: "Describe the project",
    inputs: ["manifest"],
    toolsAllowed: ["project.describe"],
    permissions: ["read_project", "project_scoped_write"],
    validation: ["manifest_schema_valid"],
    rollback: "git_snapshot",
    maxRetriesPerOperation: 2,
    instructions: "Write a short, accurate description of what the project contains today. Do not describe planned features as finished.",
  },
];

export function skill(id: string): SkillDef {
  const s = SKILLS.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown skill '${id}'`);
  return s;
}
