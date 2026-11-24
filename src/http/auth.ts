import { timingSafeEqual } from "node:crypto";

export const TOKEN_HEADER = "x-lv24-diagram-token";

/** Compares the request token against the configured one without early-exit on content. */
export function isValidToken(
  provided: string | string[] | undefined,
  expected: string,
): boolean {
  if (!expected) return false;
  const value = Array.isArray(provided) ? provided[0] : provided;
  if (!value) return false;
  const given = Buffer.from(value);
  const wanted = Buffer.from(expected);
  if (given.length !== wanted.length) return false;
  return timingSafeEqual(given, wanted);
}
