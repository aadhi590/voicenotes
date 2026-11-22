import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";

const STORAGE_KEY = "voicenotes.deviceId";
const VALID_ID = /^[A-Za-z0-9-]{8,64}$/;

let pending: Promise<string> | null = null;

async function loadOrCreate(): Promise<string> {
  try {
    const existing = await AsyncStorage.getItem(STORAGE_KEY);
    if (existing && VALID_ID.test(existing)) return existing;
  } catch {
    // Storage unavailable: fall through and use a fresh id for this session.
  }
  const id = Crypto.randomUUID();
  try {
    await AsyncStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Not persisted; next launch gets a new id (notes are per-device on the server anyway).
  }
  return id;
}

/** Stable per-install id sent as X-Device-Id / ?device_id=. Generated once, then persisted. */
export function getDeviceId(): Promise<string> {
  pending ??= loadOrCreate();
  return pending;
}
