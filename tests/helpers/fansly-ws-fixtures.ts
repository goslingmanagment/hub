export const syntheticSecret = "SYNTHETIC_AUTH_AND_COOKIE_SECRET";
export const syntheticMessage = "SYNTHETIC_PRIVATE_CORRESPONDENCE";

export function wrapped(t: number, payload: unknown): string {
  return JSON.stringify({ t, d: JSON.stringify(payload) });
}

export function serviceFrame(event: unknown, serviceId = 5) {
  return wrapped(10000, { serviceId, event: JSON.stringify(event) });
}

export function received(frame: string) {
  return {
    direction: "received", url: "wss://wsv3.fansly.com/?v=3",
    receivedAt: "2026-09-10T18:00:00.000Z", frame,
  };
}

export function privateMessageEvent() {
  return {
    type: 1,
    message: { id: "987654321098765432", groupId: "123456789012345678", content: syntheticMessage },
    cookie: syntheticSecret,
    [syntheticSecret]: { nested: JSON.stringify({ token: syntheticSecret }) },
  };
}
