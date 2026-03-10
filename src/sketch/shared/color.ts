export function hexToNormalizedRgba(hex: string): [number, number, number, number] {
  const normalizedHex = hex.startsWith('#') ? hex.slice(1) : hex;
  const red = Number.parseInt(normalizedHex.slice(0, 2), 16) / 255;
  const green = Number.parseInt(normalizedHex.slice(2, 4), 16) / 255;
  const blue = Number.parseInt(normalizedHex.slice(4, 6), 16) / 255;

  return [red, green, blue, 1];
}
