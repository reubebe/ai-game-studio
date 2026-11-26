import { test, expect, type Page } from "@playwright/test";
import { nextRandom } from "../../packages/ludo/src/engine";

/** A dice seed whose first roll is a 6. */
function firstSixSeed(): number {
  let seed = 1;
  while (Math.floor(nextRandom(seed).value * 6) !== 5) seed++;
  return seed;
}

const problems = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const list: string[] = [];
  problems.set(page, list);
  page.on("pageerror", (e) => list.push(`page error: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") list.push(`console error: ${m.text()}`);
  });
  await page.goto("/");
  await expect(page.getByText("Browser preview")).toBeVisible();
});

test.afterEach(async ({ page }) => {
  expect(problems.get(page)).toEqual([]);
});

const nav = (page: Page, label: string) => page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: label, exact: true }).click();
const setMode = (page: Page, mode: "Creator" | "Designer" | "Developer") => page.getByRole("group", { name: "Work mode" }).getByRole("button", { name: mode }).click();

const pickTemplate = (page: Page, template: string) => page.getByRole("dialog", { name: "New project" }).getByRole("radiogroup", { name: "Template" }).locator(`input[value="${template}"]`).check();

async function createProject(page: Page, template: string) {
  await nav(page, "Home");
  await page.getByRole("button", { name: "New project" }).first().click();
  await pickTemplate(page, template);
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

async function seedTotal(page: Page, board = "Oware board"): Promise<number> {
  const labels = await page.getByRole("group", { name: board }).locator("[aria-label]").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""));
  return labels.reduce((sum, l) => sum + Number(/(\d+) seeds|captured (\d+)/.exec(l)?.slice(1).find(Boolean) ?? 0), 0);
}

test("home lists ready, foundation and planned templates honestly", async ({ page }) => {
  await expect(page.getByRole("button", { name: "Oware (Abapa)" })).toBeEnabled();
  await expect(page.getByRole("button", { name: /^3D exploration: Sun Crystal Valley/ })).toBeEnabled();
  await expect(page.getByRole("button", { name: /^3D exploration in Unity/ })).toBeEnabled();
  await expect(page.getByRole("button", { name: /^3D exploration in Unreal(?!: realistic)/ })).toBeEnabled();
  await expect(page.getByRole("button", { name: /^3D exploration in Unreal: realistic people/ })).toBeEnabled();
  await expect(page.getByRole("button", { name: /\(foundation\)/ }).filter({ hasText: /Unity|Unreal/ })).toHaveCount(0);
  // Ayò, Ludo and the 2D platformer are built now, so nothing is listed as planned.
  for (const name of [/^Ayò/, /^Ludo/, /^2D platformer/]) await expect(page.getByRole("button", { name })).toBeEnabled();
  await expect(page.locator(".planned-row")).toHaveCount(0);
});

test("New project shows every template and starts with none picked", async ({ page }) => {
  await page.getByRole("button", { name: "New project" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  const picker = dialog.getByRole("radiogroup", { name: "Template" });
  // Opening on the first template (Oware) in a closed list made New project look as if it only made Oware games.
  await expect(picker.getByRole("radio")).toHaveCount(17);
  await expect(picker.getByRole("radio", { checked: true })).toHaveCount(0);
  await expect(dialog.getByText("Pick a template to see what it includes.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Create project" })).toBeDisabled();
  for (const id of ["oware-abapa", "oware-namnam", "exploration-unity", "exploration-unreal", "platformer-2d", "cpp-sfml-arcade"]) await expect(picker.locator(`input[value="${id}"]`)).toBeVisible();
  // The realistic Unreal template copies Epic's Game Animation Sample, which only the desktop app can find.
  await pickTemplate(page, "exploration-unreal-realistic");
  await expect(dialog.getByRole("textbox", { name: "Title" })).toHaveValue("Realistic Valley");
  await expect(dialog.getByText(/needs Epic's free Game Animation Sample on this Mac first\. Checking for it needs the desktop app\./)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Create project" })).toBeDisabled();
  await pickTemplate(page, "exploration-unity");
  await expect(dialog.getByRole("textbox", { name: "Title" })).toHaveValue("Sun Crystal Valley Unity");
  await expect(dialog.getByText(/The same valley as a Unity 6 project/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Create project" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  // A template's card on Home opens the dialog with that template picked.
  await page.getByRole("button", { name: "Ludo", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "New project" }).getByRole("radiogroup", { name: "Template" }).locator('input[value="ludo"]')).toBeChecked();
});

test("board games pause, resign and keep a game in progress when you leave and come back", async ({ page }) => {
  await createProject(page, "oware-abapa");
  const message = page.getByTestId("oware-message");
  await page.getByRole("button", { name: /^Pit C: 4 seeds, playable/ }).click();
  await expect(page.getByTestId("move-log")).toContainText("North", { timeout: 15_000 });
  // Pause: the board is covered, pits cannot be played, and the computer waits.
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByTestId("board-paused")).toBeVisible();
  await expect(page.getByRole("button", { name: /playable/ })).toHaveCount(0);
  await page.keyboard.press("p");
  await expect(page.getByTestId("board-paused")).toHaveCount(0);
  await expect(message).toContainText("Resumed: South to move");
  // Leaving the Play view keeps the game; coming back finds it paused, with its moves.
  await nav(page, "Home");
  await expect(page.getByTestId("home-continue")).toContainText("Oware Evening");
  await page.getByRole("button", { name: "Play Oware Evening" }).click();
  await expect(page.getByTestId("board-paused")).toBeVisible();
  await expect(message).toContainText("Your game is where you left it (2 moves), paused");
  await expect(page.getByRole("button", { name: /^Pit C: 0 seeds/ })).toBeVisible();
  await page.getByTestId("board-paused").getByRole("button", { name: "Resume" }).click();
  // Resign: asked first, the computer wins, and Undo takes it back.
  await page.getByRole("button", { name: "Resign" }).click();
  const dialog = page.getByRole("dialog", { name: "Resign this game?" });
  await expect(dialog).toContainText("South gives up and North wins.");
  await dialog.getByRole("button", { name: "Resign" }).click();
  await expect(message).toHaveText("South resigned, so North wins.");
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeEnabled();
  // New game asks before throwing a game in progress away.
  await page.getByRole("button", { name: "New game" }).click();
  await expect(page.getByRole("dialog", { name: "Start a new game?" })).toContainText("will be lost");
  await page.getByRole("dialog", { name: "Start a new game?" }).getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: /^Pit C: 0 seeds/ })).toBeVisible();
});

test("Ludo pauses and ends a game with nobody winning", async ({ page }) => {
  await createProject(page, "ludo");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByTestId("board-paused")).toBeVisible();
  await expect(page.getByTestId("ludo-roll")).toBeDisabled();
  await page.getByTestId("board-paused").getByRole("button", { name: "Resume" }).click();
  await page.getByRole("button", { name: "End game" }).click();
  await page.getByRole("dialog", { name: "End this game?" }).getByRole("button", { name: "End game" }).click();
  await expect(page.getByTestId("ludo-turn")).toHaveText("Game ended");
  await expect(page.getByTestId("ludo-message")).toHaveText("Game ended. Nobody won.");
});

test("Home: Continue opens recent projects to Play or Edit, and the gallery filters by kind", async ({ page }) => {
  await createProject(page, "football");
  await nav(page, "Home");
  const card = page.getByTestId("project-card").filter({ hasText: "Harbour Cup Final" });
  await expect(card).toContainText("Football: Harbour Cup Final");
  await expect(card).toContainText("Open now");
  await card.getByRole("button", { name: "Edit Harbour Cup Final" }).click();
  await expect(page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Workspace: rules, world and files" })).toHaveAttribute("aria-current", /page|true/);
  await nav(page, "Home");
  const kinds = page.getByRole("group", { name: "Kinds of game" });
  await kinds.getByRole("button", { name: /^Board games/ }).click();
  await expect(page.getByRole("button", { name: "Ludo", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^3D exploration: Sun Crystal Valley/ })).toHaveCount(0);
  await kinds.getByRole("button", { name: /^All/ }).click();
  await expect(page.getByRole("button", { name: /^3D exploration: Sun Crystal Valley/ })).toBeVisible();
});

test("Oware Nam-nam: a second Oware game with relay sowing, houses that show their owner and rounds", async ({ page }) => {
  // The Abapa template stays; Nam-nam is listed beside it.
  await nav(page, "Home");
  await page.getByRole("button", { name: "New project" }).first().click();
  const picker = page.getByRole("dialog", { name: "New project" }).getByRole("radiogroup", { name: "Template" });
  for (const id of ["oware-abapa", "oware-namnam"]) await expect(picker.locator(`input[value="${id}"]`)).toBeVisible();
  await page.getByRole("dialog", { name: "New project" }).getByRole("button", { name: "Cancel" }).click();
  await createProject(page, "oware-namnam");
  await expect(page.getByRole("group", { name: "Oware board" })).toBeVisible();
  expect(await seedTotal(page)).toBe(48);
  await expect(page.getByTestId("oware-round")).toHaveText("Round 1");
  await expect(page.getByTestId("oware-message")).toContainText("South starts round 1");
  await expect(page.getByTestId("oware-rules")).toContainText("goes to its owner, in either player's move");
  await expect(page.getByTestId("oware-rules")).toContainText("The players take turns to start");
  await page.getByRole("button", { name: /^Pit a: 4 seeds, North's house/ }).hover();
  await expect(page.getByRole("tooltip")).toContainText("North's house: it is South's turn");
  // A relay sowing through the rule graph, then the computer's answer.
  await page.getByRole("button", { name: /^Pit A: 4 seeds, South's house, playable/ }).click();
  await expect(page.getByTestId("oware-message")).toContainText("South sowed 4 from A, lifting again from", { timeout: 15_000 });
  await expect(page.getByTestId("move-log")).toContainText("North", { timeout: 20_000 });
  await expect(page.getByTestId("move-log")).toContainText("Round 1");
  await expect.poll(() => seedTotal(page)).toBe(48);
});

test("Ayò: its own board, sources and a move answered by the computer", async ({ page }) => {
  await createProject(page, "ayo");
  await expect(page.getByRole("group", { name: "Ayò board" })).toBeVisible();
  expect(await seedTotal(page, "Ayò board")).toBe(48);
  await page.getByRole("button", { name: /^Pit D: 4 seeds, playable/ }).click();
  await expect(page.getByTestId("move-log")).toContainText("North", { timeout: 15_000 });
  await page.getByRole("button", { name: "Sources" }).click();
  await expect(page.getByText("Other accounts of Ayò").first()).toBeVisible();
});

test("Ludo: roll, bring a token out on a 6, and the computer takes its turn", async ({ page }) => {
  // Seed the dice so Red's first roll is a 6 (the game takes its seed from crypto.getRandomValues).
  const seed = firstSixSeed();
  await page.addInitScript((s) => {
    const original = crypto.getRandomValues.bind(crypto);
    crypto.getRandomValues = (<T extends ArrayBufferView | null>(array: T): T => {
      if (array instanceof Uint32Array && array.length === 1) {
        array[0] = s;
        return array;
      }
      return original(array as never) as T;
    }) as typeof crypto.getRandomValues;
  }, seed);
  await page.reload();
  await createProject(page, "ludo");
  await expect(page.getByRole("group", { name: "Ludo board" })).toBeVisible();
  await expect(page.getByTestId("ludo-seed")).toContainText(String(seed));
  // A token cannot move before rolling, and says why.
  await page.getByTestId("token-0-0").hover();
  await expect(page.getByRole("tooltip")).toContainText("Roll the die first");
  await page.getByTestId("ludo-roll").click();
  await expect(page.getByTestId("ludo-message")).toContainText("Red rolled 6");
  await page.getByRole("button", { name: /^Red token 1, in the yard, can move/ }).click();
  await expect(page.getByRole("button", { name: /^Red token 1, 0 squares along/ })).toBeVisible();
  await expect(page.getByTestId("ludo-message")).toContainText("roll again");
  // Red's second roll: use it if a token can move, then the computer (Yellow) plays.
  await page.getByTestId("ludo-roll").click();
  const legal = page.locator(".ludo-token--legal");
  if ((await legal.count()) > 0) await legal.first().click();
  await expect(page.getByTestId("ludo-log")).toContainText("Yellow rolled", { timeout: 15_000 });
});

test("Oware: a move is sown through the rule graph and the computer replies", async ({ page }) => {
  await createProject(page, "oware-abapa");
  await expect(page.getByRole("group", { name: "Oware board" })).toBeVisible();
  expect(await seedTotal(page)).toBe(48);
  // A pit that cannot be played says why.
  await page.getByRole("button", { name: /^Pit f: 4 seeds/ }).hover();
  await expect(page.getByRole("tooltip")).toContainText("North's pit: it is South's turn");
  await page.getByRole("button", { name: /^Pit C: 4 seeds, playable/ }).click();
  await expect(page.getByTestId("move-log")).toContainText("South");
  await expect(page.getByTestId("move-log")).toContainText("North", { timeout: 15_000 });
  // Seeds in hand during the sowing animation are not on the board, so wait for it to settle.
  await expect.poll(() => seedTotal(page)).toBe(48);
  await expect(page.getByRole("button", { name: /^Pit C: 0 seeds/ })).toBeVisible();
  // With the computer playing, one Undo takes back its reply and your move.
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("button", { name: /^Pit C: 4 seeds/ })).toBeVisible();
  await expect(page.getByTestId("move-log")).not.toContainText("North");
});

test("Oware: ending by agreement needs both players, and the result is said in words", async ({ page }) => {
  await createProject(page, "oware-abapa");
  const message = page.getByTestId("oware-message");
  // The computer does not agree while the game is not going round in circles; the game goes on.
  await page.getByRole("button", { name: "Agree to end" }).click();
  await expect(message).toContainText("North (the computer) does not agree: the game is not going round in circles yet.");
  await expect(page.getByRole("button", { name: /^Pit A: 4 seeds, playable/ })).toBeVisible();
  // Two people at the board both confirm, after seeing what each would finish with.
  await page.getByRole("group", { name: "Computer plays" }).getByRole("button", { name: "Nobody" }).click();
  await page.getByRole("button", { name: "Agree to end" }).click();
  const dialog = page.getByRole("dialog", { name: "End the game by agreement?" });
  await expect(dialog).toContainText("South would finish with 24 seeds and North with 24: a draw.");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: /^Pit A: 4 seeds, playable/ })).toBeVisible();
  await page.getByRole("button", { name: "Agree to end" }).click();
  await page.getByRole("dialog", { name: "End the game by agreement?" }).getByRole("button", { name: "We both agree" }).click();
  await expect(message).toHaveText("Ended by agreement: each player took the seeds on their own side. A draw, 24 seeds each.");
  // The rules summary says what each setting means.
  await expect(page.getByTestId("oware-rules")).toContainText("Legal, but nothing is captured (Abapa)");
  await expect(page.getByTestId("oware-rules")).toContainText("25 or more; 24 each is a draw");
});

test("Oware: a variant setting edited in Creator mode survives save, reload and reopen", async ({ page }) => {
  await createProject(page, "oware-abapa");
  await nav(page, "Workspace: rules, world and files");
  await setMode(page, "Creator");
  const counts = page.getByLabel("Capture when a pit holds");
  await expect(counts).toHaveValue("2, 3");
  await counts.fill("2, 3, 4");
  await counts.press("Enter");
  await page.getByRole("button", { name: /^Save \(\d+\)$/ }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Edit Oware Evening" }).click();
  await nav(page, "Workspace: rules, world and files");
  await setMode(page, "Creator");
  await expect(page.getByLabel("Capture when a pit holds")).toHaveValue("2, 3, 4");
});

test("rule graph: the designer canvas compiles, edits are undoable and marked unsaved", async ({ page }) => {
  await createProject(page, "oware-abapa");
  await nav(page, "Workspace: rules, world and files");
  await setMode(page, "Designer");
  await expect(page.getByTestId("compile-status")).toHaveText(/Compiles/);
  await expect(page.getByTestId("rule-node-guard")).toBeVisible();
  const before = await page.locator("[data-testid^=rule-node-]").count();
  await page.getByRole("button", { name: /^Log: drag onto the canvas/ }).dblclick();
  await expect(page.locator("[data-testid^=rule-node-]")).toHaveCount(before + 1);
  await expect(page.getByLabel("unsaved changes")).toBeVisible();
  await page.getByRole("button", { name: "Undo (⌘Z)" }).click();
  await expect(page.locator("[data-testid^=rule-node-]")).toHaveCount(before);
});

test("assistant: a typed proposal is shown before applying and applying snapshots it", async ({ page }) => {
  await createProject(page, "oware-abapa");
  await nav(page, "AI assistant");
  const send = page.getByRole("button", { name: "Send" });
  await expect(send).toBeDisabled();
  await send.hover({ force: true });
  await expect(page.getByRole("tooltip")).toContainText("Type a message first");
  await page.getByRole("button", { name: "Make pits with 4 seeds capturable too" }).click();
  await page.getByRole("button", { name: "Send" }).click();
  const proposal = page.getByTestId("proposal");
  await expect(proposal).toContainText("[2,3] → [2,3,4]");
  await proposal.getByRole("button", { name: "Apply changes" }).click();
  await expect(proposal).toContainText("Applied and snapshotted");
  await page.getByRole("button", { name: "Snapshot", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Assistant: Also capture pits that hold four seeds.");
});

test("chat: replies stream in, questions get answers without changes, and Stop ends a reply", async ({ page }) => {
  await createProject(page, "exploration-3d");
  await nav(page, "AI assistant");
  const box = page.getByRole("textbox", { name: "Message for the assistant" });
  await box.fill("Add a tree near the start");
  await box.press("Enter");
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  const replies = page.getByTestId("reply");
  await expect(replies.first()).toContainText("Add one round tree near the player start.");
  await expect(page.getByTestId("proposal")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();

  // A follow-up question: the earlier turn is sent along, and the answer proposes nothing.
  await box.fill("What could make this level more fun?");
  await box.press("Enter");
  await expect(replies.nth(1)).toContainText("a question gets a reply and no changes");
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  await expect(page.getByTestId("proposal")).toHaveCount(1);

  // Stop: the reply ends and nothing is proposed.
  await box.fill("Add a tree slowly");
  await box.press("Enter");
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(replies.nth(2)).toContainText("Stopped. Nothing was changed.");
  await expect(page.getByTestId("proposal")).toHaveCount(1);

  // The conversation is still there after leaving the assistant, until New chat.
  await nav(page, "Home");
  await nav(page, "AI assistant");
  await expect(replies).toHaveCount(3);
  await page.getByRole("button", { name: "New chat" }).click();
  await expect(replies).toHaveCount(0);
});

test("exploration: drag an object onto the world map, then simulate the level rules", async ({ page }) => {
  await createProject(page, "exploration-3d");
  const map = page.getByRole("application", { name: "Top-down map of the level" });
  await expect(map).toBeVisible();
  const header = page.getByText(/^Objects \(\d+\)$/);
  const count = Number(/\((\d+)\)/.exec((await header.textContent()) ?? "")?.[1]);
  await page.getByRole("button", { name: "Add Rock" }).dragTo(map);
  await expect(page.getByText(`Objects (${count + 1})`)).toBeVisible();
  await page.getByText("Sun Crystal Valley rules").first().click();
  await page.getByRole("tab", { name: "Simulate" }).click();
  const sim = page.locator(".sim");
  await sim.getByRole("button", { name: "On Start", exact: true }).click();
  await expect(sim.locator(".console")).toContainText("start");
  await sim.getByLabel("Collectible to collect").selectOption("crystal_1");
  await sim.getByRole("button", { name: "Collect", exact: true }).click();
  await expect(sim.locator(".console")).toContainText("Sun crystal 1 of 3");
  await expect(sim.locator(".kv").first()).toContainText("crystal_1");
});

test("3D adventure: enemies and blocks go on the map, and the simulator plays beetles, plates and the sunset timer", async ({ page }) => {
  await createProject(page, "adventure-3d");
  const map = page.getByRole("application", { name: "Top-down map of the level" });
  await expect(map).toBeVisible();
  const header = page.getByText(/^Objects \(\d+\)$/);
  const count = Number(/\((\d+)\)/.exec((await header.textContent()) ?? "")?.[1]);
  await page.getByRole("button", { name: "Add Enemy" }).dragTo(map);
  await expect(page.getByText(`Objects (${count + 1})`)).toBeVisible();
  await expect(page.getByLabel("Health (hits)")).toHaveValue("2");
  await expect(page.getByLabel("Sight (m)")).toHaveValue("8");
  await page.getByRole("button", { name: "Add Pushable block" }).click();
  await expect(page.getByText(`Objects (${count + 2})`)).toBeVisible();
  await expect(page.getByLabel("Look")).toHaveValue("wood");
  await page.getByText("Thornwood Ruins rules").first().click();
  await page.getByRole("tab", { name: "Simulate" }).click();
  const sim = page.locator(".sim");
  const log = sim.locator(".console");
  await sim.getByRole("button", { name: "On Start", exact: true }).click();
  // The enemy just placed is a beetle too, so the rules count five.
  await expect(log).toContainText("Defeat the 5 thorn beetles in the ruins.");
  await sim.getByLabel("Enemy", { exact: true }).selectOption("beetle_1");
  await sim.getByRole("button", { name: "Hits the player" }).click();
  await expect(sim.locator(".kv").first()).toContainText("4 of 5");
  await sim.getByRole("button", { name: "Defeat", exact: true }).click();
  await expect(log).toContainText("Thorn beetle defeated: 1 of 5");
  for (const [block, plate] of [["block_1", "plate_1"], ["block_2", "plate_2"]] as const) {
    await sim.getByLabel("Block to push").selectOption(block);
    await sim.getByLabel("Zone to push the block into").selectOption(plate);
    await sim.getByRole("button", { name: "Push in" }).click();
  }
  await expect(log).toContainText("Gate opened: gate_ruins");
  await expect(log).toContainText('Timer sunset started: 90 s, showing "Sunset in"');
  await sim.getByLabel("Running timer").selectOption("sunset");
  await sim.getByRole("button", { name: "Run out" }).click();
  await expect(log).toContainText("The sun has set");
  await sim.getByLabel("Zone", { exact: true }).selectOption("beacon");
  await sim.getByRole("button", { name: "Enter", exact: true }).click();
  await expect(log).toContainText("Level complete: You lit the beacon. Thornwood is safe again.");
});

test("villagers who answer with AI: the elder's persona and knowledge are edited in the inspector and can be switched off", async ({ page }) => {
  await createProject(page, "exploration-3d");
  await page.locator(".tree-item", { hasText: /^elder/ }).first().click();
  const answers = page.getByRole("switch", { name: "Answers players with AI (in Game Studio)" });
  await expect(answers).toBeChecked();
  await expect(page.getByLabel("Who they are")).toHaveValue(/oldest woman in Sun Crystal Valley/);
  await expect(page.getByLabel("What they know")).toHaveValue(/Three sun crystals are hidden/);
  await page.getByLabel("Who they are").fill("A grumpy old guardian who speaks in riddles.");
  await page.getByLabel("What they know").click();
  await expect(page.getByLabel("unsaved changes")).toBeVisible();
  await answers.click();
  await expect(page.getByLabel("Who they are")).toHaveCount(0);
  await page.locator(".tree-item", { hasText: /^sign_path/ }).first().click();
  await expect(page.getByRole("switch", { name: "Answers players with AI (in Game Studio)" })).toHaveCount(0);
});

test("3D adventure: the beetles, blocks and gate use the Kiln models, and the inspector can swap them for the built-in shapes", async ({ page }) => {
  await createProject(page, "adventure-3d");
  await page.locator(".tree-item", { hasText: /^block_1/ }).first().click();
  const model = page.getByLabel("Model", { exact: true });
  await expect(model).toHaveValue("assets/models/kiln/stone-block.gltf");
  // The project carries the models, so they are offered (not marked missing), with the wooden crate too.
  await expect(model.locator("option")).toHaveText(["None (the look above)", "models/kiln/shrine-gate.gltf", "models/kiln/stone-block.gltf", "models/kiln/thorn-beetle.gltf", "models/kiln/wood-crate.gltf"]);
  await expect(page.getByLabel("Look")).toBeDisabled();
  await model.selectOption("");
  await expect(page.getByLabel("Look")).toBeEnabled();
  await expect(page.getByLabel("unsaved changes")).toBeVisible();
  await page.locator(".tree-item", { hasText: /^gate_ruins/ }).first().click();
  await expect(page.getByLabel("Model", { exact: true })).toHaveValue("assets/models/kiln/shrine-gate.gltf");
  await page.locator(".tree-item", { hasText: /^beetle_1/ }).first().click();
  await expect(page.getByLabel("Character model")).toHaveValue("assets/models/kiln/thorn-beetle.gltf");
  await expect(page.getByLabel("Height (m)")).toHaveValue("1.1");
});

test("Unity and Unreal projects show the Godot-only adventure pieces as unavailable, with the reason", async ({ page }) => {
  await createProject(page, "exploration-unity");
  await expect(page.getByRole("application", { name: "Top-down map of the level" })).toBeVisible();
  for (const name of ["Add Enemy", "Add Pushable block"]) {
    const button = page.getByRole("button", { name });
    await expect(button).toBeDisabled();
    await button.hover({ force: true });
    await expect(page.getByRole("tooltip")).toContainText("work in Godot projects");
  }
  await expect(page.getByRole("button", { name: "Add Rock" })).toBeEnabled();
  await nav(page, "Workspace: rules, world and files");
  await page.getByText("Sun Crystal Valley rules").first().click();
  await setMode(page, "Designer");
  const timer = page.getByRole("button", { name: /^Start Timer: drag onto the canvas/ });
  await expect(timer).toBeDisabled();
  await timer.hover({ force: true });
  await expect(page.getByRole("tooltip")).toContainText("Works in Godot projects only");
  await expect(page.getByRole("button", { name: /^Open Gate: drag onto the canvas/ })).toBeEnabled();
});

test("football: squads are named and edited in the match editor, and the simulator follows goals by name to full time and the golden goal", async ({ page }) => {
  await createProject(page, "football");
  const editor = page.locator(".match-editor");
  await expect(editor).toBeVisible();
  await expect(editor.getByRole("table", { name: "Harbour Lions squad" })).toBeVisible();
  const forward = editor.getByLabel("home player 5 name");
  await expect(forward).toHaveValue("Kofi Antwi");
  await forward.fill("Abena Quaye");
  await forward.press("Enter");
  await expect(editor.getByRole("img", { name: /with 5 players a side/ })).toBeVisible();
  await editor.getByRole("group", { name: "Players a side" }).getByRole("button", { name: "3", exact: true }).click();
  await expect(editor.getByRole("img", { name: /with 3 players a side/ })).toBeVisible();
  await editor.getByRole("button", { name: "Undo" }).click();
  await expect(editor.getByRole("img", { name: /with 5 players a side/ })).toBeVisible();
  await editor.getByRole("group", { name: "You play" }).getByRole("button", { name: "Watch" }).click();
  await expect(editor.getByText("Home team (the computer's)")).toBeVisible();
  await page.getByText("Harbour Cup rules").first().click();
  await page.getByRole("tab", { name: "Simulate" }).click();
  const sim = page.locator(".sim");
  const log = sim.locator(".console");
  await sim.getByRole("button", { name: "On Start", exact: true }).click();
  await expect(log).toContainText("Caption: Win the Harbour Cup!");
  await sim.getByLabel("Scorer").selectOption("home:4");
  await sim.getByRole("button", { name: "Goal", exact: true }).click();
  await expect(log).toContainText("GOAL! Abena Quaye for Harbour Lions  1 – 0");
  await sim.getByLabel("Scorer").selectOption("away:3");
  await sim.getByRole("button", { name: "Goal", exact: true }).click();
  await expect(log).toContainText("GOAL! Yaw Ansah for Hilltop Rovers  1 – 1");
  await sim.getByRole("button", { name: "Full time" }).click();
  await expect(log).toContainText("Caption: Golden goal: the next goal wins!");
  await sim.getByRole("button", { name: "Full time" }).click();
  await expect(log).toContainText("Match over: Full time: still level after the golden goal. The cup is shared!");
  await expect(sim.getByRole("button", { name: "Goal", exact: true })).toBeDisabled();
});

test("farm simulation: paint the map and add a crop, then plant, water, harvest and sell in the simulator through market day", async ({ page }) => {
  await createProject(page, "farm-sim");
  const editor = page.locator(".farm-editor");
  await expect(editor).toBeVisible();
  const paint = editor.getByRole("group", { name: "Paint" });
  await expect(paint.getByRole("button", { name: /^Soil 32$/ })).toBeVisible();
  await paint.getByRole("button", { name: /^Soil/ }).click();
  const map = editor.getByRole("application", { name: /^Farm map, 20 by 12 tiles/ });
  const box = (await map.boundingBox())!;
  await page.mouse.click(box.x + (1.5 / 20) * box.width, box.y + (1.5 / 12) * box.height);
  await expect(paint.getByRole("button", { name: /^Soil 33$/ })).toBeVisible();
  await editor.getByRole("button", { name: "Undo" }).click();
  await expect(paint.getByRole("button", { name: /^Soil 32$/ })).toBeVisible();
  await editor.getByRole("button", { name: "Add crop" }).click();
  await expect(editor.getByLabel("crop_5 name")).toHaveValue("Crop 5");
  await editor.getByLabel("crop_5 name").fill("Pumpkin");
  await editor.getByLabel("crop_5 name").press("Enter");
  await page.getByText("Sunrise Acres rules").first().click();
  await page.getByRole("tab", { name: "Simulate" }).click();
  const sim = page.locator(".sim");
  const log = sim.locator(".console");
  await sim.getByRole("button", { name: "On Start", exact: true }).click();
  await expect(log).toContainText("Goal: Have 300 coins by the morning of day 8.");
  await expect(sim.getByLabel("Crop")).toContainText("Pumpkin");
  await sim.getByLabel("Crop").selectOption("okra");
  await sim.getByRole("button", { name: "Plant", exact: true }).click();
  await expect(log).toContainText('planted {"crop":"okra","cropName":"Okra"}');
  for (let i = 0; i < 2; i++) {
    await sim.getByRole("button", { name: "Water all" }).click();
    await sim.getByRole("button", { name: "New day" }).click();
  }
  await sim.getByRole("button", { name: "Harvest", exact: true }).click();
  await expect(log).toContainText("Harvested 2 Okra");
  await sim.getByRole("button", { name: "Sell", exact: true }).click();
  await expect(sim.locator(".kv").first()).toContainText("66 coins");
  await sim.getByRole("button", { name: "New day" }).click();
  await expect(log).toContainText("Price of tomato: 12");
  await expect(log).toContainText("Market day! Tomatoes sell for double today.");
});

test("2D platformer: the side-view editor adds, edits, undoes and deletes objects, and the rules simulate", async ({ page }) => {
  await createProject(page, "platformer-2d");
  const canvas = page.getByTestId("level-canvas");
  await expect(canvas).toBeVisible();
  const header = page.getByText(/^Objects \(\d+\)$/);
  const count = Number(/\((\d+)\)/.exec((await header.textContent()) ?? "")?.[1]);
  expect(count).toBeGreaterThan(20);

  // Drag a coin into the level: it is added and selected.
  await page.getByRole("button", { name: "Add Coin" }).dragTo(canvas);
  await expect(page.getByText(`Objects (${count + 1})`)).toBeVisible();
  await expect(page.getByText(/^coin_\d+ · coin$/)).toBeVisible();

  // Edit it in the inspector.
  const x = page.getByLabel("x (tiles)");
  await x.fill("21.5");
  await x.press("Enter");
  await expect(page.locator(".tree-item[aria-selected=true]")).toContainText("21.5,");

  // Undo the edit and the add, then redo the add.
  const undo = page.getByRole("button", { name: "Undo" });
  await undo.click();
  await expect(page.locator(".tree-item[aria-selected=true]")).not.toContainText("21.5,");
  await undo.click();
  await expect(page.getByText(`Objects (${count})`)).toBeVisible();
  await page.getByRole("button", { name: "Redo" }).click();
  await expect(page.getByText(`Objects (${count + 1})`)).toBeVisible();

  // Pressing a palette item adds in the middle of the view; Delete removes the selection.
  await page.getByRole("button", { name: "Add Spikes" }).click();
  await expect(page.getByText(`Objects (${count + 2})`)).toBeVisible();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText(`Objects (${count + 1})`)).toBeVisible();
  await expect(page.getByText("Level settings")).toBeVisible();
  // Without pictures or sounds in the project, the platform picture and sound settings say how to get them.
  await expect(page.getByLabel("Music", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("Coin sound", { exact: true })).toBeDisabled();
  // Without a sprite sheet in the project, the player sprite setting says how to get one.
  await expect(page.getByLabel("Player sprite")).toBeDisabled();
  await expect(page.getByText("Import a sprite sheet (.png, equal frames in a grid) in Assets to draw the player from it.")).toBeVisible();

  // The level's rules: collecting a coin counts it, and the start sets the objective.
  await page.getByText("Sunset Cliffs rules").first().click();
  await page.getByRole("tab", { name: "Simulate" }).click();
  const sim = page.locator(".sim");
  await sim.getByRole("button", { name: "On Start", exact: true }).click();
  await expect(sim.locator(".console")).toContainText(/Collect all \d+ sun coins/);
  const coin = await sim.getByLabel("Coin to collect").locator("option").nth(1).getAttribute("value");
  await sim.getByLabel("Coin to collect").selectOption(coin!);
  await sim.getByRole("button", { name: "Collect", exact: true }).click();
  await expect(sim.locator(".console")).toContainText(coin!);
});

test("start from an idea: the plan is shown first, then the game is created with the planned changes", async ({ page }) => {
  await nav(page, "Home");
  await page.getByRole("button", { name: "Start from an idea" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Plan my game" })).toBeDisabled();
  await dialog.getByLabel("Describe your game").fill("A firefly collects lantern seeds on a moonlit ridge");
  // A stray click outside, or Esc, must not throw away what was typed.
  await page.mouse.click(5, 5);
  await page.keyboard.press("Escape");
  await expect(dialog.getByLabel("Describe your game")).toHaveValue("A firefly collects lantern seeds on a moonlit ridge");
  await dialog.getByRole("button", { name: "Plan my game" }).click();
  const plan = dialog.getByTestId("idea-plan");
  await expect(plan).toContainText("Lantern Ridge");
  await expect(plan).toContainText("2D platformer: Sunset Cliffs");
  await expect(plan).toContainText("Level skyTop");
  await expect(plan).toContainText("Gather every lantern seed");
  await dialog.getByRole("button", { name: "Create this game" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // The new project opens on its level, already carrying the planned changes.
  await expect(page.getByTestId("level-canvas")).toBeVisible();
  await expect(page.getByLabel("Level name")).toHaveValue("Lantern Ridge");
  await expect(page.getByLabel("skyTop")).toHaveValue("#0d1b3d");
});

test("characters: world settings explain where characters come from, and the free library needs the desktop app", async ({ page }) => {
  await createProject(page, "exploration-3d");
  await expect(page.getByLabel("Character", { exact: true })).toBeDisabled();
  await expect(page.getByText("Import a character (.glb or .gltf) in Assets, or add one from the free library's Characters, to play as it.")).toBeVisible();
  // Sound settings and object textures say where their files come from.
  await expect(page.getByLabel("Music", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("Chime sound", { exact: true })).toBeDisabled();
  await expect(page.getByText("Import sounds or music (.ogg, .wav or .mp3) in Assets, or add free ones from the library's Sounds, to use them here.")).toBeVisible();
  await page.locator(".tree-item", { hasText: "rock_1" }).click();
  await expect(page.locator("#obj-texture")).toBeDisabled();
  await expect(page.getByText("Import a texture in Assets, or get one from the free library's Textures, to use it here.")).toBeVisible();
  await page.getByRole("button", { name: "Add Character" }).click();
  await expect(page.getByLabel("Character model")).toBeDisabled();
  await nav(page, "Asset library");
  await expect(page.getByRole("button", { name: "Free library" })).toBeDisabled();
});

type LevelViewHandle = { levelView: { screenPoint(x: number, y: number, z: number): { x: number; y: number } | null; cameraState(): { position: number[]; target: number[] } } };

test("3D view: drag, turn and drop objects in 3D; the map shows the same edits and shares undo", async ({ page }) => {
  await createProject(page, "exploration-3d");
  const views = page.getByRole("group", { name: "View" });
  await views.getByRole("button", { name: "3D" }).click();
  const canvas = page.getByRole("application", { name: "3D view of the level" }).locator("canvas");
  await expect(canvas).toBeVisible();
  const screenPoint = (x: number, y: number, z: number) => canvas.evaluate((c, a) => (c as unknown as LevelViewHandle).levelView.screenPoint(a[0]!, a[1]!, a[2]!), [x, y, z]);

  // Picking from the list selects the elder and turns the camera to her; dragging her body moves her east.
  await page.locator(".tree-item", { hasText: "elder" }).click();
  await expect(page.locator("#obj-x")).toHaveValue("4");
  const at = (await screenPoint(4, 1, 24))!;
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 100, at.y, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator("#obj-z")).toHaveValue("24");
  const x = Number(await page.locator("#obj-x").inputValue());
  expect(x).toBeGreaterThan(8);

  // E turns her 15° clockwise; undo is shared with the map.
  await page.keyboard.press("e");
  await expect(page.locator("#obj-rot")).toHaveValue("215");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator("#obj-rot")).toHaveValue("200");
  const camera = await canvas.evaluate((c) => (c as unknown as LevelViewHandle).levelView.cameraState());
  await views.getByRole("button", { name: "Map" }).click();
  await expect(page.getByRole("application", { name: "Top-down map of the level" })).toBeVisible();
  await expect(page.locator(".tree-item", { hasText: "elder" })).toContainText(`${x}, 24`);
  await page.getByRole("button", { name: "Undo (⌘Z)" }).click();
  await expect(page.locator(".tree-item", { hasText: "elder" })).toContainText("4, 24");

  // Back in 3D, the camera is where it was. Drop a rock from the palette, then a click on empty ground clears the selection.
  await views.getByRole("button", { name: "3D" }).click();
  await expect(canvas).toBeVisible();
  expect(await canvas.evaluate((c) => (c as unknown as LevelViewHandle).levelView.cameraState())).toEqual(camera);
  const header = page.getByText(/^Objects \(\d+\)$/);
  const count = Number(/\((\d+)\)/.exec((await header.textContent()) ?? "")?.[1]);
  await page.getByRole("button", { name: "Add Rock" }).dragTo(canvas);
  await expect(page.getByText(`Objects (${count + 1})`)).toBeVisible();
  await expect(page.locator(".inspector__title").first()).toHaveText(/^rock_\d+$/);
  const empty = (await screenPoint(-30, 0, 25))!;
  await page.mouse.click(empty.x, empty.y);
  await expect(page.getByText("Level settings", { exact: true })).toBeVisible();
});

test("trackpad: pinching zooms the map and the 3D view, and scrolling zooms the map toward the pointer", async ({ page }) => {
  await createProject(page, "exploration-3d");
  const map = page.getByRole("application", { name: "Top-down map of the level" });
  await expect(map).toBeVisible();
  const viewBox = async () => ((await map.getAttribute("viewBox")) ?? "").split(" ").map(Number);
  // WebKit reports a trackpad pinch as gesturestart / gesturechange / gestureend with a running scale.
  // Chromium has no such events, so this sends them the way WebKit does.
  const pinch = (x: number, y: number, scales: number[]) =>
    page.evaluate(([x, y, scales]) => {
      const el = document.elementFromPoint(x, y)!;
      const fire = (type: string, scale: number) => el.dispatchEvent(Object.assign(new Event(type, { bubbles: true, cancelable: true }), { scale, clientX: x, clientY: y }));
      fire("gesturestart", 1);
      for (const s of scales) fire("gesturechange", s);
      fire("gestureend", scales[scales.length - 1]!);
    }, [x, y, scales] as const);

  const box = (await map.boundingBox())!;
  const [, , w0] = await viewBox();
  await pinch(box.x + box.width / 2, box.y + box.height / 2, [1.1, 1.25, 1.5]);
  await expect.poll(async () => (await viewBox())[2]!).toBeLessThan(w0! * 0.7);

  // Scrolling in at the right-hand side keeps that spot under the pointer, so the middle moves right.
  const [x0, , w1] = await viewBox();
  await page.mouse.move(box.x + box.width * 0.85, box.y + box.height / 2);
  await page.mouse.wheel(0, -300);
  await expect.poll(async () => (await viewBox())[2]!).toBeLessThan(w1! * 0.9);
  const [x2, , w2] = await viewBox();
  expect(x2! + w2! / 2).toBeGreaterThan(x0! + w1! / 2 + 1);

  await page.getByRole("group", { name: "View" }).getByRole("button", { name: "3D" }).click();
  const canvas = page.getByRole("application", { name: "3D view of the level" }).locator("canvas");
  await expect(canvas).toBeVisible();
  const distance = () => canvas.evaluate((c) => {
    const s = (c as unknown as LevelViewHandle).levelView.cameraState();
    return Math.hypot(s.position[0]! - s.target[0]!, s.position[1]! - s.target[1]!, s.position[2]! - s.target[2]!);
  });
  const d0 = await distance();
  const cbox = (await canvas.boundingBox())!;
  await pinch(cbox.x + cbox.width / 2, cbox.y + cbox.height / 2, [1.2, 1.5]);
  expect(await distance()).toBeLessThan(d0 * 0.75);
  await pinch(cbox.x + cbox.width / 2, cbox.y + cbox.height / 2, [0.8, 0.5]);
  expect(await distance()).toBeGreaterThan(d0 * 0.95);
});

test("foundations play inside the studio: encounter, lesson and logic sandbox", async ({ page }) => {
  await createProject(page, "creature-collection");
  await nav(page, "Play and run");
  await page.getByRole("button", { name: "Start encounter" }).click();
  await page.getByRole("button", { name: /^Peck/ }).click();
  await expect(page.getByText(/used Peck/)).toBeVisible();

  await createProject(page, "science-lesson");
  await nav(page, "Play and run");
  const q2 = page.getByTestId("question-stride_vs_step");
  await q2.getByRole("button", { name: "Two" }).click();
  await q2.getByRole("button", { name: "Check" }).click();
  await expect(q2).toContainText("Correct.");

  await createProject(page, "logic-sandbox");
  await nav(page, "Play and run");
  await page.getByRole("button", { name: "Run start" }).click();
  await expect(page.locator(".sim .console")).toContainText("start");
});

test("engine runs are honest in the browser preview: Godot export, Unity and Unreal projects", async ({ page }) => {
  await createProject(page, "exploration-3d");
  await nav(page, "Play and run");
  const playHere = page.getByRole("button", { name: "Play here" });
  await expect(playHere).toBeDisabled();
  await playHere.hover({ force: true });
  await expect(page.getByRole("tooltip")).toContainText("browser preview cannot run engines");
  const exportButton = page.getByRole("button", { name: "Export for macOS" });
  await expect(exportButton).toBeDisabled();
  // WebKit sends no pointer events to disabled buttons; the wrapper with the reason must get the hover.
  expect(await exportButton.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("none");
  await exportButton.hover({ force: true });
  await expect(page.getByRole("tooltip")).toContainText("browser preview cannot run engines");
  for (const name of ["Export for Windows", "Export for Linux"]) {
    const button = page.getByRole("button", { name });
    await expect(button).toBeDisabled();
    await button.hover({ force: true });
    await expect(page.getByRole("tooltip")).toContainText("browser preview cannot run engines");
  }

  await createProject(page, "exploration-unity");
  await expect(page.getByRole("button", { name: "World layout" })).toBeVisible();
  await nav(page, "Play and run");
  await expect(page.getByText("Unity 6000.6.9f1")).toBeVisible();
  await expect(page.getByText(/Rules not in Unity/)).toHaveCount(0);
  for (const name of ["Open in Unity", "Build and run", "Self-test", "Build only"]) await expect(page.getByRole("button", { name })).toBeDisabled();

  await createProject(page, "exploration-unreal");
  await nav(page, "Play and run");
  await expect(page.getByText("Unreal Engine 5.8")).toBeVisible();
  await expect(page.getByText(/Rules not in Unreal/)).toHaveCount(0);
  for (const name of ["Open in Unreal", "Package and run", "Self-test", "Package only"]) await expect(page.getByRole("button", { name })).toBeDisabled();
});

test("project screens explain themselves with no project open, and opening one lands back there", async ({ page }) => {
  const rail = page.getByRole("navigation", { name: "Main navigation" });
  // Each rail button shows a short name under its icon.
  for (const short of ["Home", "Workspace", "Play", "Assets", "Assistant", "Engines", "Plugins", "Settings"]) await expect(rail.getByText(short, { exact: true })).toBeVisible();
  for (const label of ["Workspace: rules, world and files", "Play and run", "Asset library", "AI assistant"]) {
    await expect(rail.getByRole("button", { name: label, exact: true })).toBeEnabled();
  }
  await nav(page, "Play and run");
  await expect(page.getByRole("heading", { name: "Play and run needs an open project" })).toBeVisible();
  await nav(page, "AI assistant");
  const empty = page.locator(".no-project");
  await expect(empty.getByRole("heading", { name: "AI assistant needs an open project" })).toBeVisible();
  await expect(empty.getByRole("button", { name: "Open folder" })).toBeEnabled();
  await empty.getByRole("button", { name: "New project" }).click();
  await pickTemplate(page, "exploration-3d");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".no-project")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message for the assistant" })).toBeVisible();
});

test("every main view renders for an open project", async ({ page }) => {
  await createProject(page, "exploration-3d");
  for (const [label, heading] of [["Play and run", "Play in Godot"], ["Asset library", "Asset library"], ["Engines", "Engines"], ["Plugins and modules", "Plugins and modules"], ["Settings", "Work mode"]] as const) {
    await nav(page, label);
    await expect(page.getByText(heading, { exact: true }).first()).toBeVisible();
  }
  await expect(page.getByTestId("view-error")).toHaveCount(0);
});
