/**
 * The ordinary server beside an owner's classic herdr, with no engine lifecycle authority. Its local owner is
 * whoever connects to `<state folder>/serve.sock`: the kernel lets only this account (and root) in there. Its
 * TCP port tells everyone that it is alive and nothing else; its devices come through the relay.
 */
import { type Dirent, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { harmlessGroups, trustRefusal } from "./herdr-core/discovery.ts";
import { chosenHerdrSocketStatus, discoverHerdrSessions, validHerdrSocket } from "./herdr-discovery.ts";
import { herdrSocketPath, ping } from "./herdr/client.ts";
import { isJsonObject, jsonResponse, setRequestRoute } from "./http.ts";
import { acquireOwnerDirectory, holdForLife, liveOwner, OwnerGuardBusy } from "./owner-guard.ts";
import { writePrivateState } from "./private-state.ts";
import { stateDirNames } from "./update-state.ts";

/** The machine profile takes no direct connections, only the relay. This is deliberately not an environment override. */
export const MACHINE_DIRECT_CARRIER_ENABLED = false;

export class MachineProfileError extends Error {}

/** The local owner's socket in a state folder: a path the server never takes from anything but its folder. */
export function ownerSocketPath(stateDir: string): string { return join(stateDir, "serve.sock"); }
/** The longest socket path served: a longer one Bun would listen on, while curl's --unix-socket cannot reach it. */
const SOCKET_PATH_MAX = 100;

/** Read the selection without invoking runtime discovery, hc, a login shell or any core connection. */
export function machineEngine(stateDir: string, port: number): string {
  const named = process.env["OVIS_RUNTIME"];
  if (named) return named;
  try {
    const saved: unknown = JSON.parse(readFileSync(join(stateDir, `runtime-${port}.json`), "utf8"));
    if (isJsonObject(saved) && typeof saved.runtime === "string") return saved.runtime;
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  return "herdr";
}

/** A path as the system resolves it (links, `..`, a trailing slash, relative to the working folder), also where its last parts do not exist yet. */
function canonical(path: string): string {
  try { return realpathSync(path); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    const absolute = resolve(path);
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(canonical(parent), basename(absolute));
  }
}

/**
 * The state folder, made 0700 where it is absent, once its path holds: every folder and link on the way from
 * `/` is this account's or root's and no other account can write one (a sticky folder on the way, such as
 * /tmp, passes), and the folder itself is this account's own with mode 0700. The owner's socket is found by
 * this path, so only this account or root can move it. On a refusal the folders made here are taken away.
 */
function walkedStateDir(told: string): string {
  const made = mkdirSync(told, { recursive: true, mode: 0o700 });
  const stateDir = realpathSync(told);
  const stats = statSync(stateDir);
  const refusal = trustRefusal(stateDir, harmlessGroups(), true)
    ?? (stats.uid !== process.getuid?.() ? `${stateDir} belongs to uid ${stats.uid}, not to this account`
      : (stats.mode & 0o7777) !== 0o700 ? `${stateDir} has mode ${(stats.mode & 0o7777).toString(8).padStart(4, "0")}, not 0700` : null);
  if (refusal === null) return stateDir;
  if (made !== undefined) for (let dir = resolve(told); ; dir = dirname(dir)) { rmdirSync(dir); if (dir === resolve(made)) break; }
  throw new MachineProfileError(`The machine profile's state folder is not safe to serve from, so no server was started: ${refusal}`);
}

/**
 * A lease per canonical state folder, across checkouts and ports of the machine profile. Never on a
 * folder the ordinary server uses by default, one whose path another account could change, nor one an
 * Ovis's supervisor or an ordinary server holds: a second responder there would answer with that Ovis's
 * relay key. Nothing is written before these are ruled out. The state folder is held exclusively for the
 * life of the process (`serve.own`, which an ordinary server holds shared), and its owner's socket is
 * `serve.sock` in it.
 */
export function claimServerState(told: string | undefined) {
  const own = "name a folder of its own with OVIS_STATE_DIR";
  const { legacy, next } = stateDirNames(process.env);
  if (!told || [legacy, next].some((dir) => canonical(dir) === canonical(told))) {
    throw new MachineProfileError(`The machine profile does not run on a default Ovis state folder, so no server was started; ${own}`);
  }
  const named = ownerSocketPath(canonical(told));
  if (Buffer.byteLength(named) > SOCKET_PATH_MAX) {
    throw new MachineProfileError(`The machine profile's socket ${named} would be longer than ${SOCKET_PATH_MAX} bytes, so no server was started; name a shorter folder with OVIS_STATE_DIR`);
  }
  const stateDir = walkedStateDir(told);
  const updates = join(stateDir, "updates");
  let ids: Dirent[] = [];
  try { ids = readdirSync(updates, { withFileTypes: true }); }
  catch (error) { if (!(error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR"))) throw error; }
  for (const id of ids) {
    const holder = id.isDirectory() ? liveOwner(join(updates, id.name, "supervisor.lock")) : null;
    if (holder !== null) throw new MachineProfileError(`An Ovis already runs on this state folder (${holder}), so no second server was started; ${own}`);
  }
  const running = "Another server already owns this Ovis state directory, so no second server was started";
  const hold = join(stateDir, "serve.own");
  try { holdForLife(hold, "exclusive"); }
  catch (error) {
    if (error instanceof OwnerGuardBusy) throw new MachineProfileError(`${running} (${hold} is held)`);
    throw new MachineProfileError(`The machine profile cannot hold its state folder, so no server was started (${error instanceof Error ? error.message : String(error)})`);
  }
  const lease = acquireOwnerDirectory(join(stateDir, "serve.lock"), {
    running,
    starting: "Another server is claiming this Ovis state directory, so no second server was started",
  }, {}, { wait: false });
  const socket = ownerSocketPath(stateDir);
  // a socket file a killed server left: nothing listens there, and this process holds the folder now
  rmSync(socket, { force: true });
  // `door`: this lease's server takes its local owner on `socket` alone, and answers only liveness on TCP
  return { stateDir, socket, release: lease.release, listening: (port: number, hostname: string) => lease.amend((lock) => writePrivateState(join(lock, "http.json"), { port, hostname, socket, door: 1 })) };
}

/** The herdr this server runs, and where that came from: OVIS_HERDR_BIN, or the PATH. */
export function machineHerdrBinary(): string {
  const named = process.env["OVIS_HERDR_BIN"];
  if (named) return `herdr binary: ${named} (from OVIS_HERDR_BIN)`;
  return `herdr binary: ${Bun.which("herdr") ?? "herdr, not found"} (from PATH)`;
}

/** Pin a safe classic session once. An absent explicit socket stays selected for its return. */
export async function machineSocket(stateDir: string, engine: string): Promise<string | null> {
  const unavailable = join(stateDir, "unavailable", "herdr.sock");
  if (engine !== "herdr") { process.env["HERDR_SOCKET"] = unavailable; return `${engine} is not supported for a machine yet`; }
  const named = process.env["HERDR_REMOTE_SESSION"];
  const socket = process.env["HERDR_REMOTE_SOCKET"];
  let selected = socket || (named ? join(process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config"), "herdr", "sessions", named, "herdr.sock") : process.env["HERDR_SOCKET"]);
  process.env["HERDR_SOCKET"] = unavailable;
  if (named && !/^[A-Za-z0-9_-]{1,64}$/.test(named)) return "HERDR_REMOTE_SESSION must name a herdr session";
  if (selected && !validHerdrSocket(selected)) return `${socket ? "HERDR_REMOTE_SOCKET" : named ? "HERDR_REMOTE_SESSION" : "HERDR_SOCKET"} must be an absolute path ending in /herdr.sock`;
  if (!selected) {
    const found = await discoverHerdrSessions();
    if (found.length !== 1) return found.length === 0 ? "herdr is not running for the selected session" : "Several herdr sessions are running; select one with HERDR_REMOTE_SOCKET";
    selected = found[0]?.socket_path;
  }
  if (!selected || await chosenHerdrSocketStatus(selected) === "refused") return "The selected herdr socket cannot be used safely by this account";
  process.env["HERDR_SOCKET"] = selected;
  return null;
}

/** Readiness is separate from the HTTP server's liveness and is only sent after authentication. `refusal`: why the engine serve() chose is down, null while it answers. */
export async function machineHealth(engine: string, refusal: string | null = engine === "herdr" ? null : `${engine} is not supported for a machine yet`) {
  let reason = refusal;
  let herdr: Awaited<ReturnType<typeof ping>> | undefined;
  if (reason === null) {
    try {
      herdr = await ping(herdrSocketPath(), 1500);
      if (herdr.protocol < 22) reason = "herdr protocol 22 or newer is required; update herdr explicitly";
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      reason = `${engine} is not running for the selected session`;
    }
  }
  return { machine_profile: { engine, runtime_down: reason !== null, reason }, ...(herdr ? { herdr } : {}) };
}

/** Refused before optional route handlers, for local owners and devices alike. A device cookie opens nothing here, so none is handed out. */
export function machineRouteRestricted(path: string): boolean {
  return /^\/api\/(?:herdr\/update$|runtime(?:\/|$)|portal(?:\/|$)|fleet(?:\/|$)|machines(?:\/|$)|bridge$|devices\/pair$)/.test(path)
    || path === "/api/relay/direct" && !MACHINE_DIRECT_CARRIER_ENABLED;
}

/** The answer to a caller the profile does not let in, the plain text the terminal socket's client reads included. */
export function machineUnauthorized(pathname: string): Response {
  setRequestRoute("auth-refusal");
  return pathname === "/ws" ? new Response("unauthorized", { status: 401 })
    : jsonResponse({ error: { code: "unauthorized", message: "This machine's server answers its owner on its socket, and devices through the relay" } }, 401);
}

/**
 * The profile's TCP port, for every caller and whatever the request carries (a token, a cookie, a forwarding
 * or identity header): its liveness at /api/health, 401 for every other API call and the terminal socket, and
 * nothing else.
 */
export function machineTcpAnswer(request: Request, pathname: string): Response {
  if (pathname === "/api/health" && (request.method === "GET" || request.method === "HEAD")) {
    setRequestRoute(pathname);
    return jsonResponse({ ok: true }, 200, { "cache-control": "no-store" });
  }
  if (pathname === "/ws" || pathname.startsWith("/api/")) return machineUnauthorized(pathname);
  setRequestRoute("not-found");
  return jsonResponse({ error: { code: "not_found", message: "not found" } }, 404);
}
