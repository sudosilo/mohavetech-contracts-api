import crypto from "node:crypto";
import { promisify } from "node:util";
import { redis } from "./redis.js";

const scrypt = promisify(crypto.scrypt);

const PIN_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const PIN_LENGTH = 6;
const MAX_TRIES = 5;
const LOCK_SECONDS = 15 * 60;

export function newPin() {
  let pin = "";
  for (let i = 0; i < PIN_LENGTH; i++) {
    pin += PIN_ALPHABET[crypto.randomInt(PIN_ALPHABET.length)];
  }
  return pin;
}

export function normalizePin(input) {
  return typeof input === "string" ? input.toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
}

export async function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(pin, salt, 32);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export async function pinMatches(pin, stored) {
  if (!pin || !stored) return false;
  const [saltHex, hashHex] = stored.split(":");
  const expected = Buffer.from(hashHex, "hex");
  const given = await scrypt(pin, Buffer.from(saltHex, "hex"), expected.length);
  return crypto.timingSafeEqual(given, expected);
}

export async function countAttempt(contractId) {
  const key = `pin-tries:${contractId}`;
  const tries = await redis.incr(key);
  if (tries === 1) await redis.expire(key, LOCK_SECONDS);
  if (tries > MAX_TRIES) {
    return { allowed: false, retryAfterSeconds: Math.max(await redis.ttl(key), 1) };
  }
  return { allowed: true, triesLeft: MAX_TRIES - tries };
}

export async function clearAttempts(contractId) {
  await redis.del(`pin-tries:${contractId}`);
}
