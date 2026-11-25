import { useEffect, useMemo, useRef, useState } from "react";
import { RuleRuntime, type RuleProgram, type Scalar } from "@gamestudio/rules-core";
import { FarmSimHost, parseFarm, type Farm, type FarmEffect } from "@gamestudio/farm";
import { useProject } from "../../state/project";
import { Button, Notice, Switch } from "../../components/ui";
import { PlayIcon, ResetIcon } from "../../components/icons";

function effectText(e: FarmEffect): string {
  switch (e.type) {
    case "message": return `Message (${e.seconds}s): ${e.text}`;
    case "goal": return `Goal: ${e.text}`;
    case "sound": return `Sound: ${e.sound}`;
    case "money": return `Money ${e.change >= 0 ? "+" : ""}${e.change}: ${e.money}`;
    case "price": return `Price of ${e.crop}: ${e.price}`;
    case "rain": return "It rains: every crop is watered";
    case "end": return `Season over: ${e.text}`;
  }
}

/** Fires the farm's events at a model of it (FarmSimHost): money, days, prices and what grows, without starting Godot. */
export function FarmSimulator({ program, onTrace }: { program: RuleProgram; onTrace: (ids: string[]) => void }) {
  const manifest = useProject((s) => s.manifest);
  const loadDoc = useProject((s) => s.loadDoc);
  const farmPath = manifest?.data.find((d) => d.kind === "farm-sim")?.path;
  const farmDoc = useProject((s) => (farmPath ? s.docs[farmPath] : undefined));
  useEffect(() => {
    if (farmPath) void loadDoc(farmPath);
  }, [farmPath, loadDoc]);
  const farm = useMemo<Farm | null>(() => {
    const r = farmDoc && !farmDoc.error ? parseFarm(farmDoc.data) : null;
    return r?.ok ? r.farm : null;
  }, [farmDoc]);
  const sim = useRef<{ runtime: RuleRuntime; host: FarmSimHost } | null>(null);
  const [lines, setLines] = useState<{ id: number; text: string; kind: string }[]>([]);
  const n = useRef(0);
  const [, force] = useState(0);
  const [crop, setCrop] = useState("");
  const [rain, setRain] = useState(false);
  const push = (text: string, kind: string) => setLines((l) => [{ id: ++n.current, text, kind }, ...l].slice(0, 200));
  const reset = () => {
    sim.current = farm ? { runtime: new RuleRuntime(program), host: new FarmSimHost(farm) } : null;
    setLines([]);
    setCrop(farm?.crops[0]?.id ?? "");
    force((x) => x + 1);
  };
  useEffect(reset, [program, farm]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!farm) return <Notice kind="warn">The farm settings are missing or invalid, so the rules cannot be simulated. Open data/farm.json to fix them.</Notice>;
  const s = sim.current;
  if (!s) return null;
  const fire = (event: string, payload: Record<string, Scalar>) => {
    const before = s.host.effects.length;
    const r = s.runtime.run(event, payload, s.host);
    push(`${event} ${JSON.stringify(payload)}${r.handled ? "" : " (no rule handles this event)"}`, "event");
    for (const e of s.host.effects.slice(before)) push(effectText(e), "effect");
    for (const l of r.logs) push(`log: ${l}`, "log");
    if (r.error) push(`Rule error at ${r.error.node}: ${r.error.message}`, "error");
    onTrace(r.trace);
    force((x) => x + 1);
  };
  /** Runs a step of the farm (the host may refuse it, as the game would) and the event it raises. */
  const step = (run: () => { event: string; payload: Record<string, Scalar> } | null) => {
    try {
      const e = run();
      if (e) fire(e.event, e.payload);
      else force((x) => x + 1);
    } catch (err) {
      push(err instanceof Error ? err.message : String(err), "error");
    }
  };
  const c = farm.crops.find((x) => x.id === crop) ?? farm.crops[0]!;
  const over = s.host.ended !== null;
  const ready = s.host.ready(c.id);
  const basket = s.host.inventory[c.id] ?? 0;
  return (
    <div className="sim">
      <div className="row row--wrap" style={{ gap: 8, padding: 10, borderBottom: "1px solid var(--line)" }}>
        <Button size="small" icon={<PlayIcon />} onClick={() => fire("start", {})}>On Start</Button>
        <span className="faint">|</span>
        <select className="select" style={{ width: 130 }} aria-label="Crop" value={c.id} onChange={(e) => setCrop(e.target.value)}>
          {farm.crops.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
        <Button size="small" disabled={over || s.host.money < c.seedCost} tip={`Plant one ${c.name} (${c.seedCost} ${farm.currency})`} onClick={() => step(() => ({ event: "planted", payload: s.host.plant(c.id) }))}>Plant</Button>
        <Button size="small" disabled={over || s.host.plots.length === 0} tip="Water every planted tile for today" onClick={() => step(() => { s.host.waterAll(); push("Watered every planted tile", "effect"); return null; })}>Water all</Button>
        <Button size="small" disabled={over || ready === 0} tip={ready ? `${ready} tile(s) of ${c.name} ready` : `No ${c.name} is ready yet`} onClick={() => step(() => ({ event: "harvested", payload: s.host.harvest(c.id) }))}>Harvest</Button>
        <Button size="small" disabled={over || basket === 0} tip={basket ? `Sell ${basket} ${c.name} at ${s.host.prices[c.id]} each` : `No ${c.name} in the basket`} onClick={() => step(() => ({ event: "sold", payload: s.host.sell(c.id) }))}>Sell</Button>
        <span className="faint">|</span>
        <Switch checked={rain} label="Rain tomorrow" onChange={setRain} />
        <Button size="small" disabled={over} tip="Sleep: crops that were watered grow, and a new day starts" onClick={() => step(() => ({ event: "newDay", payload: s.host.newDay(rain) }))}>New day</Button>
        <span className="spacer" />
        <Button size="small" variant="ghost" icon={<ResetIcon />} onClick={reset}>Reset</Button>
      </div>
      <div className="sim__cols">
        <div className="console" style={{ flex: 1 }}>
          {lines.length === 0 && <span className="muted">Plant, water, harvest and sell, then start a new day, to run the compiled rules against a model of the farm. Executed nodes light up on the canvas.</span>}
          {lines.map((l) => <div key={l.id} className={l.kind === "error" ? "console__line--stderr" : l.kind === "event" ? "console__line--studio" : ""}>{l.kind === "effect" ? "  → " : ""}{l.text}</div>)}
        </div>
        <div className="sim__state">
          <div className="section-label">Farm state</div>
          <dl className="kv">
            <dt>Day</dt><dd>{s.host.day}{s.host.raining ? " (rain)" : ""}</dd>
            <dt>Money</dt><dd>{s.host.money} {farm.currency}</dd>
            <dt>Growing</dt><dd>{s.host.plots.length ? farm.crops.map((x) => { const tiles = s.host.plots.filter((p) => p.crop === x.id); return tiles.length ? `${x.name} ${tiles.length} (${tiles.filter((p) => p.grown >= x.days).length} ready)` : ""; }).filter(Boolean).join(", ") : "nothing"}</dd>
            <dt>Basket</dt><dd>{farm.crops.filter((x) => (s.host.inventory[x.id] ?? 0) > 0).map((x) => `${x.name} ${s.host.inventory[x.id]}`).join(", ") || "empty"}</dd>
            <dt>Prices</dt><dd>{farm.crops.map((x) => `${x.name} ${s.host.prices[x.id]}`).join(", ")}</dd>
            <dt>Goal</dt><dd>{s.host.goal || "none yet"}</dd>
            <dt>Season</dt><dd>{s.host.ended ?? "going on"}</dd>
          </dl>
          <div className="section-label">Variables</div>
          <dl className="kv">
            {Object.entries(s.runtime.variables).map(([k, v]) => (
              <div key={k} style={{ display: "contents" }}>
                <dt className="mono">{k}</dt>
                <dd className="mono">{JSON.stringify(v)}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </div>
  );
}
