/**
 * Persisted-session tests for the browser side of the 12-hour window.
 *
 * These cover what the server tests cannot: that the token actually outlives a
 * page load, that a lapsed record is dropped rather than replayed, and that a
 * corrupt or unavailable store degrades to "signed out" instead of throwing on
 * startup.
 */
import assert from "node:assert/strict";
import test, { afterEach, beforeEach, describe, mock } from "node:test";

class MemoryStorage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return Array.from(this.map.keys())[i] ?? null;
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v));
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
}

function installStorage(impl: unknown) {
  Object.defineProperty(globalThis, "localStorage", {
    value: impl,
    configurable: true,
    writable: true,
  });
}

installStorage(new MemoryStorage());

const { clearSession, loadSession, saveSession, touchSession, FALLBACK_SESSION_TTL_MS } =
  await import("./session");

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
const ADMIN = { email: "jvillegas@epicutis.com", label: "jvillegas@epicutis.com", role: "admin" as const };

beforeEach(() => {
  installStorage(new MemoryStorage());
});

afterEach(() => {
  mock.timers.reset();
  installStorage(new MemoryStorage());
});

describe("session persistence", () => {
  test("a saved session is readable again — this is what survives a reload", () => {
    saveSession("token-abc", ADMIN, TWELVE_HOURS_MS);
    const restored = loadSession();
    assert.ok(restored);
    assert.equal(restored.token, "token-abc");
    assert.deepEqual(restored.user, ADMIN);
    // The role is round-tripped, but the app still re-asks /api/auth/me on
    // startup and takes the server's answer — see client/src/App.tsx.
    assert.equal(restored.user.role, "admin");
  });

  test("the window defaults to 12 hours when the server sends no TTL", () => {
    assert.equal(FALLBACK_SESSION_TTL_MS, TWELVE_HOURS_MS);
    mock.timers.enable({ apis: ["Date"], now: Date.now() });
    saveSession("token-abc", ADMIN);
    assert.equal(loadSession()?.expiresAt, Date.now() + TWELVE_HOURS_MS);
  });

  test("an expired session reads as signed out and is discarded", () => {
    mock.timers.enable({ apis: ["Date"], now: Date.now() });
    saveSession("token-abc", ADMIN, TWELVE_HOURS_MS);

    mock.timers.tick(TWELVE_HOURS_MS + 1);
    assert.equal(loadSession(), null);
    // Discarded, not merely hidden — a later read cannot resurrect it.
    mock.timers.reset();
    assert.equal(loadSession(), null);
  });

  test("activity slides the deadline, idling does not", () => {
    mock.timers.enable({ apis: ["Date"], now: Date.now() });
    saveSession("token-abc", ADMIN, TWELVE_HOURS_MS);
    const original = loadSession()!.expiresAt;

    mock.timers.tick(11 * 60 * 60 * 1000);
    touchSession();
    assert.equal(loadSession()!.expiresAt, original + 11 * 60 * 60 * 1000);

    // 22 hours after sign-in, still valid because of the touch at hour 11.
    mock.timers.tick(11 * 60 * 60 * 1000);
    assert.ok(loadSession());

    // 12 idle hours after that last read do end it, and a late touch cannot
    // bring it back.
    mock.timers.tick(TWELVE_HOURS_MS + 1);
    touchSession();
    assert.equal(loadSession(), null);
  });

  test("signing out removes the stored record", () => {
    saveSession("token-abc", ADMIN, TWELVE_HOURS_MS);
    clearSession();
    assert.equal(loadSession(), null);
  });

  test("a corrupt record reads as signed out instead of throwing", () => {
    globalThis.localStorage.setItem("epicutis.orders.session.v1", "{not json");
    assert.equal(loadSession(), null);

    globalThis.localStorage.setItem("epicutis.orders.session.v1", JSON.stringify({ token: "t" }));
    assert.equal(loadSession(), null);
  });

  test("an unavailable store degrades to memory-only rather than breaking startup", () => {
    installStorage({
      getItem() {
        throw new Error("SecurityError");
      },
      setItem() {
        throw new Error("SecurityError");
      },
      removeItem() {
        throw new Error("SecurityError");
      },
    });

    assert.doesNotThrow(() => saveSession("token-abc", ADMIN, TWELVE_HOURS_MS));
    assert.equal(loadSession(), null);
    assert.doesNotThrow(() => touchSession());
    assert.doesNotThrow(() => clearSession());
  });
});
