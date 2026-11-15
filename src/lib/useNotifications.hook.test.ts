import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { resetPushHealth, type PushActionResult } from "./pushHealth.ts";
import { useNotificationState, useNotificationSwitch } from "./useNotifications.ts";
import type { AlertPrefs } from "../../shared/notify-policy.ts";

// The real hooks over a fake browser: a push manager, the Notification permission, and the PC's push routes.
describe("what Turn on alerts leaves this device", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const key = Buffer.from(new Uint8Array(65).fill(4)).toString("base64url");
  let renderer: ReactTestRenderer | undefined;
  let testPushStatus = 204;
  let permission: NotificationPermission = "granted";
  let documentEvents: EventTarget;
  let permissionEvents: EventTarget;
  let hook: { notifications: string; pushOn: boolean; enable: () => Promise<PushActionResult> };

  beforeEach(() => {
    testPushStatus = 204;
    permission = "granted";
    for (const name of ["window", "document", "navigator", "PushManager", "Notification", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    const windowEvents = new EventTarget();
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      location: { href: "https://pc.example/", hostname: "pc.example", protocol: "https:" },
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      addEventListener: windowEvents.addEventListener.bind(windowEvents), removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
    } });
    documentEvents = new EventTarget();
    Object.defineProperty(globalThis, "document", { configurable: true, value: { visibilityState: "visible", cookie: "", addEventListener: documentEvents.addEventListener.bind(documentEvents), removeEventListener: documentEvents.removeEventListener.bind(documentEvents) } });
    let live: unknown = null;
    const pushManager = {
      getSubscription: async () => live,
      subscribe: async () => {
        live = { endpoint: "https://push.example/1", options: { applicationServerKey: new Uint8Array(65).fill(4).buffer }, toJSON: () => ({ endpoint: "https://push.example/1", keys: { p256dh: "x", auth: "y" } }), unsubscribe: async () => { live = null; return true; } };
        return live;
      },
    };
    const registration = { pushManager };
    permissionEvents = new EventTarget();
    const permissions = { query: async () => permissionEvents };
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "Mozilla/5.0 Chrome/130", languages: ["en"], permissions, serviceWorker: { ready: Promise.resolve(registration), getRegistration: async () => registration } } });
    Object.defineProperty(globalThis, "PushManager", { configurable: true, value: class {} });
    Object.defineProperty(globalThis, "Notification", { configurable: true, value: { get permission() { return permission; }, requestPermission: async () => permission } });
    const fetch = async (input: string | URL | Request) => {
      const path = new URL(String(input instanceof Request ? input.url : input), "https://pc.example").pathname;
      if (path === "/api/push") return Response.json({ public_key: key });
      if (path === "/api/push/subscribe") return new Response(null, { status: 204 });
      if (path === "/api/push/test") return testPushStatus === 204 ? new Response(null, { status: 204 }) : Response.json({ error: { code: "push_failed", message: "push service 502" } }, { status: testPushStatus });
      if (path === "/api/push/status") return Response.json({ registered: true, last_success_at: null, last_failure: null, last_failure_at: null });
      return Response.json({ error: { code: "not_found", message: "no" } }, { status: 404 });
    };
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(fetch, { preconnect: globalThis.fetch.preconnect }));
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    mock.restore();
    resetPushHealth();
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    descriptors.clear();
  });

  async function mount(): Promise<void> {
    const alerts = { input: true, permission: true, done: "long" } as unknown as AlertPrefs;
    function Probe() {
      const state = useNotificationState();
      const { enableNotifications } = useNotificationSwitch({ updateSettings: () => {}, locked: true, notifications: state.notifications, setNotifications: state.setNotifications, alerts, alertsRef: { current: alerts }, alertsOn: true, setPushOn: state.setPushOn });
      hook = { notifications: state.notifications, pushOn: state.pushOn, enable: enableNotifications };
      return null;
    }
    await act(async () => { renderer = create(createElement(Probe)); });
  }

  async function enable(): Promise<PushActionResult> {
    let result: PushActionResult | undefined;
    await act(async () => { result = await hook.enable(); });
    return result!;
  }

  it("counts a push on once its confirmation push went out", async () => {
    await mount();
    expect(await enable()).toBe("sent");
    expect(hook.pushOn).toBe(true);
  });

  it("keeps the push subscription when the confirmation push failed, so the tab does not notify beside it", async () => {
    testPushStatus = 502;
    await mount();
    expect(await enable()).toBe("failed");
    expect(hook.pushOn).toBe(true);
  });

  it("reads a permission taken back while the page stays in view", async () => {
    await mount();
    await enable();
    permission = "denied";
    await act(async () => { permissionEvents.dispatchEvent(new Event("change")); });
    expect(hook.notifications).toBe("denied");
  });

  it("reads a permission taken back in the site's settings when the page comes back", async () => {
    await mount();
    await enable();
    permission = "denied";
    await act(async () => { documentEvents.dispatchEvent(new Event("visibilitychange")); });
    expect(hook.notifications).toBe("denied");
  });
});
