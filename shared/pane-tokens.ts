/**
 * herdr plugins attach short text values to a pane (`herdr pane report-metadata --token
 * name=value`): the Quota plugin's usage left, herdr-projects' summary and progress. herdr's own
 * sidebar draws one where the user's `[ui.sidebar.agents]` rows name it as `$name`. The web UI's
 * agent rows follow the `$name` tokens of those rows (server/herdr-sidebar.ts reads them from the
 * herdr config.toml of the PC the browser talks to, as herdr's sidebar is the client's config,
 * remote PCs included), and draw every token a pane has where the config names none. Kept apart
 * from protocol.ts so the browser can import the values.
 */

/**
 * One of a `$name` token's `rules`, kept only for whether it hides the token: the web UI draws
 * every token in its own dim style, so herdr's `fg`, `bold` and `dim` overrides are left out.
 * Each rule has exactly one condition.
 */
export interface PaneTokenRule {
  equals?: string;
  contains?: string;
  starts_with?: string;
  gt?: number;
  lt?: number;
  /** ASCII letters only, as herdr matches */
  ignore_case?: boolean;
  hide?: boolean;
}

export interface PaneTokenSpec {
  /** the token's name, without its `$` */
  name: string;
  /** in herdr's order: the first rule that matches decides; absent when none of them hides the token */
  rules?: PaneTokenRule[];
}

/** The `$name` tokens of herdr's `[ui.sidebar.agents]`, in the order its rows name them; a token named in two places is listed at each. */
export interface AgentRowTokens {
  /** from `rows`; null when the config sets none (herdr's default rows name no token), and a row then draws every token */
  rows: PaneTokenSpec[] | null;
  /** `rows_by_agent`: a canonical agent id's own rows, in place of `rows` */
  by_agent: Record<string, PaneTokenSpec[]>;
}

/** herdr's rule for a token's name (`report-metadata --token name=value`) */
export const PANE_TOKEN_NAME = /^[A-Za-z0-9_-]{1,32}$/;

/** a whole finite number, as herdr's `gt` and `lt` read a value: no space, unit, NaN or infinity */
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

const asciiLower = (text: string): string => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

/**
 * The token a launcher sets to file a pane under the Agents list's background agents
 * (`--token role=background`, any case, spaces around it ignored; src/lib/agentRoster.ts).
 */
export const ROLE_TOKEN = "role";

export function isBackgroundRole(value: unknown): boolean {
  return typeof value === "string" && asciiLower(value.trim()) === "background";
}

/**
 * The token herdr-projects stamps on every pane it starts: `hp_role` is `coordinator` or `session`
 * for a pane a person drives, and `thread` for a follow-up a coordinator or session started. Kept
 * apart from `role`, whose `background` value herdr's own launchers set.
 */
export const PROJECT_ROLE_TOKEN = "hp_role";

/** Whether herdr-projects files a pane as a thread (a follow-up of a primary pane). */
export function isThreadRole(value: unknown): boolean {
  return typeof value === "string" && asciiLower(value.trim()) === "thread";
}

/**
 * Whether herdr-projects filed the pane as one a person drives: `hp_role=coordinator` or
 * `hp_role=session` (any case, spaces around it ignored). A pane with any other value, or none,
 * is not one — herdr-projects' strict primary rule (its pf.22), so a hand-started or untagged
 * pane never becomes a row of its own in the people's part.
 */
export function isPrimaryRole(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const role = asciiLower(value.trim());
  return role === "coordinator" || role === "session";
}

/**
 * The coarser stamp herdr-projects also writes: `dn_session` is `thread` for a follow-up and
 * `manual` for a pane a person opened. Older or hand-driven panes carry this without an
 * `hp_role`, so it is a fallback when deciding a pane's part, never an override of `hp_role`.
 */
export const SESSION_KIND_TOKEN = "dn_session";

/** Whether the coarse `dn_session` stamp says this pane is a thread. */
export function isThreadSessionKind(value: unknown): boolean {
  return typeof value === "string" && asciiLower(value.trim()) === "thread";
}

/**
 * The project herdr-projects files a pane under, in the token it stamps for that (`hp_project`).
 * A pane started outside herdr-projects has none of those: the coarser `dn_group` stamp still
 * encodes the project (`machine-<id>-<project>!<n>!…`), so it is the fallback, never an override.
 */
export const PROJECT_TOKEN = "hp_project";

const GROUP_TOKEN = "dn_group";
const GROUP_PROJECT = /^machine-[^-]+-(.+?)!\d+!/;

/** The project a pane's tokens name, or null where neither stamp names one. */
export function paneProject(tokens: Readonly<Record<string, unknown>> | null | undefined): string | null {
  if (!tokens) return null;
  const named = tokens[PROJECT_TOKEN];
  if (typeof named === "string" && named.trim()) return named.trim();
  const group = tokens[GROUP_TOKEN];
  if (typeof group === "string") return GROUP_PROJECT.exec(group)?.[1] ?? null;
  return null;
}

/** Whether a rule's condition holds for a token's whole value, as herdr's sidebar tests it. */
export function paneTokenRuleMatches(rule: PaneTokenRule, value: string): boolean {
  if (rule.gt !== undefined || rule.lt !== undefined) {
    if (!NUMBER.test(value)) return false;
    const number = Number(value);
    if (!Number.isFinite(number)) return false;
    return rule.gt !== undefined ? number > rule.gt : number < rule.lt!;
  }
  const fold = rule.ignore_case ? asciiLower : (text: string) => text;
  if (rule.equals !== undefined) return fold(value) === fold(rule.equals);
  if (rule.contains !== undefined) return fold(value).includes(fold(rule.contains));
  if (rule.starts_with !== undefined) return fold(value).startsWith(fold(rule.starts_with));
  return false;
}

/** The `$name` tokens an agent's row draws: that agent's own rows, else `rows`; null where the config names none, and the row then draws every token. */
export function paneTokenSpecs(layout: AgentRowTokens | null, agent: string | null): PaneTokenSpec[] | null {
  return (layout && agent !== null && Object.hasOwn(layout.by_agent, agent) ? layout.by_agent[agent] : undefined) ?? layout?.rows ?? null;
}

/**
 * What a pane's tokens say on its agent row, in the order the row draws them: the tokens the
 * agent's herdr rows name, or every token (by name) where the config names none. A missing or
 * blank token says nothing, and neither does one a matching rule hides, nor, where the config names
 * none, the background tag (`role=background`). A token the rows name twice
 * is said once, at the first place whose rules leave it shown. The values are text the row writes as
 * it is, never markup.
 */
export function paneTokenValues(layout: AgentRowTokens | null, agent: string | null, tokens: Readonly<Record<string, unknown>> | null | undefined): string[] {
  if (!tokens) return [];
  const valueOf = (name: string): string | null => {
    const value = Object.hasOwn(tokens, name) ? tokens[name] : undefined;
    return typeof value === "string" && value.trim() ? value : null;
  };
  const specs = paneTokenSpecs(layout, agent);
  // the background tag already says where the row stands: a row drawing every token leaves it out
  if (specs === null) return Object.keys(tokens).sort().flatMap((name) => name === ROLE_TOKEN && isBackgroundRole(tokens[name]) ? [] : valueOf(name)?.trim() ?? []);
  const shown: string[] = [];
  const said = new Set<string>();
  for (const { name, rules } of specs) {
    if (said.has(name)) continue;
    const value = valueOf(name);
    if (value === null || rules?.find((rule) => paneTokenRuleMatches(rule, value))?.hide) continue;
    said.add(name);
    shown.push(value.trim());
  }
  return shown;
}
