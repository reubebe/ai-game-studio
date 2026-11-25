/**
 * Number-to-text formatting shared by every runtime. GDScript prints floats as
 * "3.0" while JavaScript prints "3", and the two languages round halfway values
 * differently, so the algorithm is spelled out with integer arithmetic here and
 * mirrored line for line in rules_vm.gd (_format_number):
 *  - whole numbers print without a decimal point;
 *  - other values round half-up to hundredths and drop trailing zeros.
 */
export function formatNumber(value: number): string {
  if (Number.isNaN(value)) return "nan";
  if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value === 0 ? 0 : value);
  const cents = Math.floor(value * 100 + 0.5);
  const negative = cents < 0;
  const magnitude = Math.abs(cents);
  const whole = Math.floor(magnitude / 100);
  const frac = magnitude % 100;
  let text = String(whole);
  if (frac !== 0) {
    let digits = String(frac).padStart(2, "0");
    if (digits.endsWith("0")) digits = digits.slice(0, 1);
    text += "." + digits;
  }
  return (negative && magnitude !== 0 ? "-" : "") + text;
}

export function toText(value: unknown): string {
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return value;
  return "";
}
