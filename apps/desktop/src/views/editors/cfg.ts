/** Edits key = value lines in place, keeping comments, order and unknown lines. */
export function setCfgValue(text: string, key: string, value: number): string {
  const lines = text.split("\n");
  const i = lines.findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
  const line = `${key} = ${value}`;
  if (i >= 0) lines[i] = line;
  else lines.splice(lines[lines.length - 1] === "" ? lines.length - 1 : lines.length, 0, line);
  return lines.join("\n");
}

export function readCfg(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of text.split("\n")) {
    const m = /^\s*([a-z_]+)\s*=\s*(-?[\d.]+)\s*$/.exec(l);
    if (m) out[m[1]!] = Number(m[2]);
  }
  return out;
}

