/** Minimal reader for Godot's text scene format (.tscn, format 3): enough to show the node tree. */
export interface SceneNode {
  name: string;
  type: string;
  path: string;
  parentPath: string | null;
  instance: string | null;
  groups: string[];
  properties: { key: string; value: string }[];
  children: SceneNode[];
}

export interface SceneFile {
  header: string;
  extResources: { id: string; type: string; path: string }[];
  subResources: { id: string; type: string }[];
  root: SceneNode | null;
  problems: string[];
}

function attrs(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of header.matchAll(/(\w+)=("([^"\\]|\\.)*"|\[[^\]]*\]|[^\s\]]+)/g)) {
    const raw = m[2]!;
    out[m[1]!] = raw.startsWith('"') ? raw.slice(1, -1) : raw;
  }
  return out;
}

export function parseTscn(text: string): SceneFile {
  const lines = text.split(/\r?\n/);
  const scene: SceneFile = { header: lines[0] ?? "", extResources: [], subResources: [], root: null, problems: [] };
  if (!scene.header.startsWith("[gd_scene")) scene.problems.push("This file does not start with a [gd_scene] header.");
  const nodes: SceneNode[] = [];
  let current: SceneNode | null = null;
  for (const line of lines) {
    const section = /^\[(\w+)(.*)\]\s*$/.exec(line);
    if (section) {
      current = null;
      const kind = section[1]!;
      const a = attrs(section[2] ?? "");
      if (kind === "ext_resource") scene.extResources.push({ id: a["id"] ?? "", type: a["type"] ?? "", path: a["path"] ?? "" });
      else if (kind === "sub_resource") scene.subResources.push({ id: a["id"] ?? "", type: a["type"] ?? "" });
      else if (kind === "node") {
        const parent = a["parent"] ?? null;
        const name = a["name"] ?? "?";
        const path = parent === null ? "" : parent === "." ? name : `${parent}/${name}`;
        const instance = /ExtResource\("([^"]+)"\)/.exec(a["instance"] ?? "")?.[1] ?? null;
        const groups = a["groups"] ? [...a["groups"].matchAll(/"([^"]+)"/g)].map((m) => m[1]!) : [];
        current = { name, type: a["type"] ?? (instance ? "(instance)" : "Node"), path, parentPath: parent === null ? null : parent === "." ? "" : parent, instance, groups, properties: [], children: [] };
        nodes.push(current);
      }
      continue;
    }
    const prop = /^([A-Za-z0-9_/:]+)\s*=\s*(.*)$/.exec(line);
    if (prop && current) current.properties.push({ key: prop[1]!, value: prop[2]! });
  }
  const byPath = new Map(nodes.map((n) => [n.path, n]));
  for (const n of nodes) {
    if (n.parentPath === null) {
      if (scene.root) scene.problems.push(`More than one root node (${n.name}).`);
      else scene.root = n;
    } else {
      const parent = byPath.get(n.parentPath);
      if (parent) parent.children.push(n);
      else scene.problems.push(`Node ${n.path} has a missing parent "${n.parentPath}".`);
    }
  }
  return scene;
}
