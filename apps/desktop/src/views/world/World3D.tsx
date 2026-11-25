import { useEffect, useRef, useState, type RefObject } from "react";
import { OBJECT_TYPES, type World, type WorldObjectType } from "@gamestudio/explore";
import { Button, Notice } from "../../components/ui";
import { SPAWN_ID } from "./level3d";
import { LevelView, type CameraState } from "./level3d-view";

/** What the world editor's toolbar and object list can ask of the 3D view. */
export type { CameraState };

export interface World3DApi {
  center(): { x: number; z: number };
  focus(x: number, z: number): void;
  fit(): void;
  zoom(factor: number): void;
}

export interface World3DProps {
  world: World;
  selected: string | null;
  grid: boolean;
  fog: boolean;
  snap: boolean;
  /** Snaps and clamps a position, shared with the map. */
  place: (x: number, z: number) => { x: number; z: number };
  objectMime: string;
  api: RefObject<World3DApi | null>;
  /** The camera from the last time this level was open in 3D, and where to keep it when the view closes. */
  camera: CameraState | null;
  onCameraSave: (c: CameraState) => void;
  onSelect: (id: string | null) => void;
  onMove: (id: string, x: number, z: number) => void;
  onRotate: (id: string, rotation: number) => void;
  onMoveSpawn: (x: number, z: number) => void;
  /** URL of a file in the engine project's assets (models, textures), or null where files cannot be read. */
  assetUrl?: ((asset: string) => string | null) | undefined;
  /** Whether characters and animated models move in the view. */
  animate: boolean;
  onDropObject: (type: WorldObjectType, x: number, z: number) => void;
  onUseMap: () => void;
}

/** The level in 3D, loaded only when the 3D view is opened (three.js is a large download). */
export default function World3D(props: World3DProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<LevelView | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const [failure, setFailure] = useState<string | null>(null);
  const [lost, setLost] = useState(false);
  const { api } = props;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let view: LevelView;
    try {
      view = new LevelView(host, {
        select: (id) => latest.current.onSelect(id),
        move: (id, x, z) => (id === SPAWN_ID ? latest.current.onMoveSpawn(x, z) : latest.current.onMove(id, x, z)),
        rotate: (id, rotation) => latest.current.onRotate(id, rotation),
        contextLost: setLost,
      });
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
      return;
    }
    viewRef.current = view;
    view.model.modelUrl = (asset) => latest.current.assetUrl?.(asset) ?? null;
    const saved = latest.current.camera;
    if (saved) view.restoreCamera(saved);
    api.current = { center: () => view.center(), focus: (x, z) => view.focus(x, z), fit: () => view.fit(), zoom: (f) => view.zoom(f) };
    // The self-test and UI tests reach the live view through the canvas.
    (view.canvas as HTMLCanvasElement & { levelView?: LevelView }).levelView = view;
    return () => {
      latest.current.onCameraSave(view.cameraState());
      api.current = null;
      viewRef.current = null;
      view.dispose();
    };
  }, [api]);

  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    v.place = props.place;
    v.update(props.world, props.selected, { grid: props.grid, fog: props.fog, snap: props.snap });
    v.setAnimate(props.animate);
  });

  if (failure) {
    return (
      <div className="level3d__notice">
        <div className="stack" style={{ maxWidth: 440, alignItems: "flex-start" }}>
          <Notice kind="warn">The 3D view needs WebGL 2, which this window can't provide ({failure}). The map works without it.</Notice>
          <Button size="small" onClick={props.onUseMap}>Show the map</Button>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={hostRef}
      className="level3d"
      data-testid="world-3d"
      role="application"
      aria-label="3D view of the level"
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(e) => {
        e.preventDefault();
        const t = e.dataTransfer.getData(props.objectMime) as WorldObjectType;
        const v = viewRef.current;
        if (!v || !OBJECT_TYPES.includes(t)) return;
        const p = v.groundAt(e.clientX, e.clientY) ?? v.center();
        props.onDropObject(t, p.x, p.z);
      }}
    >
      {lost && (
        <div className="level3d__notice level3d__notice--over">
          <Notice kind="warn">The 3D view lost its graphics context, which macOS can take back when graphics memory runs low. It usually returns by itself; if not, switch to Map and back.</Notice>
        </div>
      )}
    </div>
  );
}
