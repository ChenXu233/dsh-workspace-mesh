import { Context } from "@deepseek-ai/cordis";
/**
 * Zero-dependency reader for the assignment subset the mesh needs (SPEC §5.4).
 *
 * The supported YAML is deliberately small: a top-level `nodes:` mapping and a
 * top-level `assignments:` sequence. Both flow (`{ label: x, endpoint: y }`)
 * and block mappings are accepted, plus comments and quoted scalars. Anchors,
 * aliases, tags, multi-document streams, block scalars and nested flow
 * collections are rejected with the file path and line number instead of being
 * silently misread (SPEC §8: fail loudly).
 */
type AssignmentErrorCode = 'missing-file' | 'unreadable' | 'syntax' | 'schema';
declare class AssignmentFileError extends Error {
  readonly file: string;
  readonly line: number | undefined;
  readonly code: AssignmentErrorCode;
  constructor(file: string, line: number | undefined, code: AssignmentErrorCode, detail: string);
}
interface AssignmentNode {
  nodeId: string;
  label?: string;
  endpoint?: string;
  /** 1-based source line, kept for diagnostics. */
  line: number;
}
interface AssignmentRoute {
  workspaceId: string;
  nodeId: string;
  /** Directory the remote session owns; required for cross-machine dispatch. */
  cwd?: string;
  /** 1-based source line, kept for diagnostics. */
  line: number;
}
interface AssignmentTable {
  /** Absolute path (or the caller-supplied inline label) the table came from. */
  file: string;
  nodes: AssignmentNode[];
  assignments: AssignmentRoute[];
}
/** Read and parse an assignment file. Path errors keep the absolute path in the message. */
declare function loadAssignmentTable(file: string): AssignmentTable;
/** Parse assignment text. `file` is only used to build error messages. */
declare function parseAssignment(text: string, file?: string): AssignmentTable;
declare function findAssignmentNode(table: AssignmentTable | undefined, nodeId: string): AssignmentNode | undefined;
declare function findAssignmentRoute(table: AssignmentTable | undefined, workspaceId: string): AssignmentRoute | undefined;
/** Core vocabulary for workspace federation. Kept framework-free so it can be unit-tested alone. */
/** A machine running a DSH host. */
interface NodeDescriptor {
  nodeId: string;
  label: string;
  endpoint: string;
  online: boolean;
  lastSeenAt: number;
  workspaces: WorkspaceSummary[];
}
/** Metadata only — never file contents. */
interface WorkspaceSummary {
  workspaceId: string;
  name: string;
  path: string;
  sessions: SessionSummary[];
}
interface SessionSummary {
  sessionId: string;
  title: string;
  updatedAt: number;
  busy: boolean;
}
type TaskState = 'queued' | 'dispatched' | 'running' | 'done' | 'failed' | 'expired';
interface TaskPolicy {
  sessionMode: 'new' | 'resume';
  sessionId?: string;
  maxDurationMs?: number;
  replyMode: 'final' | 'stream';
}
interface Lease {
  owner: string;
  fencingToken: number;
  expiresAt: number;
}
/** A unit of work bound to exactly one workspace on exactly one node. */
interface Task {
  taskId: string;
  target: {
    nodeId: string;
    workspaceId: string;
  };
  objective: string;
  context?: string;
  acceptance?: string[];
  policy: TaskPolicy;
  lease: Lease;
  state: TaskState;
  createdAt: number;
  updatedAt: number;
  result?: TaskResult;
  error?: string;
}
interface TaskResult {
  summary: string;
  sessionId?: string;
  artifacts?: string[];
}
interface TaskListFilter {
  state?: TaskState;
  nodeId?: string;
}
/** A write may be fenced to one lease epoch (SPEC §6.3: stale writers must lose). */
interface LeaseFence {
  owner: string;
  fencingToken: number;
}
interface ClaimOptions {
  /**
   * Session-level mutual exclusion key (SPEC §7.3). claim() derives it from
   * policy.sessionId for resume tasks; a new session is bound after creation
   * with bindSession().
   */
  sessionKey?: string;
}
/**
 * Task board with the state machine from SPEC §7 and §6.3.
 * In-memory for v1; the interface is what the durable store will implement later.
 *
 * Lease semantics (SPEC §6.3, §7.2, §7.3):
 * - a lease is *live* while `expiresAt > now`; at exactly its expiry instant it is stealable
 * - a live lease held by someone else rejects the claim without touching any field
 * - a live lease held by the caller is a renewal: TTL extended, fencingToken unchanged
 * - any claim that starts a new epoch (expired or released lease) increments fencingToken,
 *   so the token is strictly increasing for the whole life of a task
 * - fenced writes are accepted only from the live lease owner with the current token;
 *   a preempted writer's late update returns false and changes nothing
 * - a session key is occupied while its task holds a live lease, enforcing the v1
 *   "one active task per session" rule from SPEC §7.3
 */
interface TaskBoard {
  /** Returns false when a task with that id already exists; an existing task is never clobbered. */
  create(task: Task): boolean;
  /** Returns a defensive copy, so callers cannot mutate lease state behind the board's back. */
  get(taskId: string): Task | undefined;
  /**
   * Patch non-identity, non-lease fields. Returns false when the task is unknown.
   * With `fence`, also returns false unless the task's lease is live and still
   * owned by that owner at that fencing epoch.
   */
  update(taskId: string, patch: Partial<Task>, fence?: LeaseFence): boolean;
  list(filter?: TaskListFilter): Task[];
  /**
   * Acquire or renew a lease. Returns false when another owner holds a live lease
   * or the derived/explicit session key already has an active task.
   */
  claim(taskId: string, owner: string, ttlMs: number, options?: ClaimOptions): boolean;
  /**
   * Bind a created session to the claiming task (SPEC §7.3). Returns false when
   * another task already holds that session key with a live lease.
   */
  bindSession(taskId: string, sessionKey: string): boolean;
  /** The task currently holding a session key, or undefined when free. */
  sessionOwner(sessionKey: string): string | undefined;
  /**
   * Clear the lease. With `owner` the release is owner-guarded: a non-matching owner
   * leaves the lease intact and returns false. Without it the lease is cleared
   * unconditionally (admin/hub path).
   */
  release(taskId: string, owner?: string): boolean;
}
/**
 * Lifecycle control — SPEC §14.
 *
 * Path A only: the plugin never spawns a process and never touches a shell.
 * It turns "please restart" into an ordinary process exit; whatever supervises
 * the host (systemd / docker / pm2) is responsible for bringing it back.
 */
type LifecycleState = 'running' | 'draining' | 'offline';
interface LifecycleStatus {
  state: LifecycleState;
  pid: number;
  startedAt: number;
  /** How the host was started, when it can be inferred. Never used to spawn anything. */
  supervisor: 'systemd' | 'docker' | 'pm2' | 'unknown';
}
interface LifecycleController {
  status(): LifecycleStatus;
  /** Drain in-flight work, then exit so the supervisor restarts us. Idempotent. */
  requestRestart(reason: string): void;
  onDrain(listener: () => Promise<void> | void): () => void;
}
interface SelfRestartOptions {
  pid?: number;
  now?: () => number;
  /** Defaults to process.exit; injected in tests. */
  exit?: (code: number) => void;
  /** Upper bound on drain work before we exit anyway. */
  drainTimeoutMs?: number;
}
declare function detectSupervisor(): LifecycleStatus['supervisor'];
declare function createSelfRestartController(options?: SelfRestartOptions): LifecycleController;
/**
 * Live plugin configuration (official "live configuration forms" convention).
 *
 * The Host discovers an exported `Config` schema on the plugin runtime and:
 * - projects the native settings form from its schemastery face
 *   (`meta`/`type`/`dict`/`toJSON`, only `.volatile()` fields become entries),
 * - validates + defaults every profile entry through cordis `resolveConfig`
 *   (`Config["~standard"].validate`), handing the resolved value to `apply`.
 *
 * The schema is authored once in scripts/gen-config-schema.mjs and ships as a
 * serialized envelope. At startup we rehydrate it through the host-side
 * schemastery runtime when available (optional peer, same framework-face
 * category as @deepseek-ai/cordis); otherwise a minimal plain face keeps
 * validation and form rendering working without the dependency.
 */
interface MeshPeerConfig {
  /** Node id used by assignment.yml and the tools. */
  nodeId: string;
  /** HTTP(S) root of the peer's web host. */
  baseUrl: string;
  /** The peer's current login token; rotates when the peer restarts. */
  token: string;
}
interface Config {
  /** Reserved for transport selection; 'auto' is the only value until an adapter ships. */
  transport?: 'auto';
  /** Peers reachable over their web API; empty = no cross-machine transport. */
  peers?: MeshPeerConfig[];
  /** Shared secret for peer handshakes; enables self-healing relay mode. */
  meshSecret?: string;
  /** Assignment table path (SPEC §5.4), resolved against the host process cwd. */
  assignmentFile?: string;
  /** Default lease TTL for a dispatched task. */
  leaseMs?: number;
  /** How long mesh_dispatch waits for a final reply before expiring the task. */
  dispatchTimeoutMs?: number;
  /** Task board lease owner recorded for dispatches made by these tools. */
  leaseOwner?: string;
}
declare const Config: Record<string, unknown>;
/**
 * The one seam that keeps third-party integration out of the core.
 *
 * Two adapters ship: `mock` (tests) and `typert` (real cross-machine RPC over the
 * peer's own web API, see transport/typert.ts).
 */
/** One conversation line, as the peer's own log records it. */
interface MeshSessionMessage {
  seq: number;
  role: 'user' | 'assistant' | 'tool' | 'system';
  text: string;
  /** Unix milliseconds from the event, when the peer recorded one. */
  time?: number;
}
/**
 * One durable session event exactly as the peer's log records it.
 *
 * The conversation renderer needs the event, not a summary: roles, tool calls,
 * turn boundaries and status all come from the same event stream the peer's own
 * page reads, so the remote transcript can be assembled by the same rules.
 */
interface MeshSessionEvent {
  seq: number;
  type?: string;
  time?: number;
  data?: unknown;
  [key: string]: unknown;
}
/** One page of a peer's session log, newest events last. */
interface MeshEventPage {
  events: MeshSessionEvent[];
  /** True when older events exist before the returned window. */
  hasMore: boolean;
  /** Highest durable seq the peer had for this session when it answered. */
  endSeq?: number;
  /** Whether the session was running when the peer answered. */
  running?: boolean;
}
/** Which slice of one session log a caller asks for. */
/** One live Assistant frame (start, chunk, or end) retained by the owning machine. */
interface MeshLiveFrame {
  readonly type?: string;
  readonly revision?: number;
  readonly attemptId?: string;
  readonly index?: number;
  readonly time?: number;
  readonly turn?: number;
  readonly step?: number;
  readonly startedAfterSeq?: number;
  readonly chunk?: unknown;
  readonly outcome?: unknown;
}
/** Everything one reader has not folded yet. */
interface MeshLivePage {
  /** Highest revision the owning machine produced so far. */
  readonly revision: number;
  /** Frames newer than the reader's revision, oldest first. */
  readonly frames: readonly MeshLiveFrame[];
}
interface MeshEventRequest {
  /** Tail cursor; omitted means the peer's current head. */
  throughSeq?: number;
  /** Page backwards from this seq (exclusive), for a follow-up page. */
  beforeSeq?: number;
  /** Upper bound on returned events. */
  maxMessages?: number;
}
interface MeshTransport {
  readonly kind: 'mock' | 'typert';
  listNodes(): Promise<NodeDescriptor[]>;
  listWorkspaces(nodeId: string): Promise<WorkspaceSummary[]>;
  createSession(nodeId: string, workspaceId: string): Promise<string>;
  prompt(nodeId: string, sessionId: string, text: string): Promise<void>;
  /** Returns an unsubscribe function. */
  follow(nodeId: string, sessionId: string, onEvent: (event: unknown) => void): Promise<() => void>;
  /**
   * Read one page of a session's raw event log.
   *
   * `readSession` flattens the log to chat lines for a summary; a conversation
   * page renders the events themselves, so it needs them verbatim. Optional for
   * the same reason as `readSession`.
   */
  readEvents?(nodeId: string, sessionId: string, request?: MeshEventRequest): Promise<MeshEventPage>;
  /**
   * Read the live Assistant frames a peer retained for one Session.
   *
   * Durable events settle a turn only once it is finished; these frames are what
   * paints the answer while it is being written. Optional: without them the page
   * shows whole messages.
   */
  readAssistantLive?(nodeId: string, sessionId: string, since: number): Promise<MeshLivePage>;
  /**
   * Read the tail of a session log. Optional: an adapter that cannot read
   * history simply leaves it out and the UI hides the viewer.
   */
  readSession?(nodeId: string, sessionId: string, limit?: number): Promise<MeshSessionMessage[]>;
  /**
   * Peer-control round trip: browse the peer's directories, or create a
   * Workspace there.
   *
   * Deliberately outside the five-method task data plane (SPEC §6.2): these are
   * administration calls made while the user is editing the workspace list, not
   * part of how a task reaches a peer. Optional — a transport without the peer's
   * relay cannot offer them.
   */
  control?(nodeId: string, op: MeshControlOp, args: Record<string, unknown>): Promise<unknown>;
}
/** Administration operations a paired peer may serve outside the task data plane. */
type MeshControlOp = 'browse' | 'workspace-create';
/**
 * Framework-free tool surface (spike §5, plan A): a definition is a plain object
 * with a raw JSON Schema `parameters`, a validated `output { schema, render }`
 * and an `execute`. `ctx.tools.register(definition)` is the only host API used;
 * the DSH tool package itself is never imported (it is not resolvable from a profile).
 */
interface MeshToolContentBlock {
  type: 'text';
  text: string;
}
interface MeshToolExec {
  /** Aborts when the host cancels the tool call. */
  signal?: AbortSignal;
  agent?: unknown;
}
interface MeshToolDefinition {
  name: string;
  description: string;
  /** Raw JSON Schema, projected to the model unchanged (spike §2.3). */
  parameters: Record<string, unknown>;
  output: {
    /** Must stay inside the supported JSON Schema subset (assertSupportedJsonSchema). */
    schema: Record<string, unknown>;
    render: (args: unknown, value: unknown) => MeshToolContentBlock[];
  };
  execute: (args: unknown, exec: MeshToolExec) => unknown | Promise<unknown>;
  timeoutMs?: number;
}
interface MeshToolRegistry {
  register(definition: MeshToolDefinition): unknown;
}
interface MeshToolHost {
  tools: MeshToolRegistry;
}
interface MeshToolConfig {
  transportMode: 'auto';
  leaseMs: number;
  leaseOwner: string;
  dispatchTimeoutMs: number;
}
/** Everything the tools need; assembled once by apply() (and by tests). */
interface MeshToolRuntime {
  board: TaskBoard;
  transport?: MeshTransport;
  /** Why transport selection degraded, when it did. */
  transportError?: string;
  assignment?: AssignmentTable;
  lifecycle: LifecycleController;
  config: MeshToolConfig;
  now?: () => number;
  newTaskId?: () => string;
}
interface TransportReport {
  configured: boolean;
  mode: string;
  kind: string;
  reason: string;
}
/** One Workspace a peer published, in the wire shape both the tool and the page consume. */
interface MeshWorkspaceView {
  workspaceId: string;
  name: string;
  path: string;
  /** Session count, so a caller can size the group without reading the list. */
  sessions: number;
  /** The Sessions themselves, newest first; read-only metadata, never a log. */
  sessionList: Array<{
    sessionId: string;
    title: string;
    updatedAt: number;
    busy: boolean;
  }>;
}
/**
 * Snapshot served to the browser settings page. Deliberately metadata only:
 * ids, states, timestamps and the lifecycle/board counters the host already
 * keeps. No task objectives beyond a short preview, no session log, no file
 * contents.
 */
declare const MESH_STATE_VERSION = 1;
/** Newest tasks kept in the payload; the board itself is unbounded. */
declare const MAX_TASK_ROWS = 25;
interface MeshStateTaskView {
  taskId: string;
  state: TaskState;
  nodeId: string;
  workspaceId: string;
  objective: string;
  createdAt: number;
  updatedAt: number;
  leaseOwner: string;
  leaseExpiresAt: number;
  error?: string;
}
interface MeshStateAssignmentView {
  configured: boolean;
  file: string;
  nodes: number;
  assignments: number;
}
interface MeshStateConfigView {
  transportMode: string;
  assignmentFile: string;
  leaseMs: number;
  dispatchTimeoutMs: number;
  leaseOwner: string;
}
/** Values buildMeshState cannot read from the runtime itself. */
interface MeshStateExtras {
  /** Effective assignment file path. */
  assignmentFile?: string;
  /** Where browser-saved overrides live. */
  configFile?: string;
}
interface MeshLifecycleView {
  state: string;
  supervisor: string;
  pid: number;
  startedAt: number;
}
interface MeshStateCounts {
  total: number;
  queued: number;
  dispatched: number;
  running: number;
  done: number;
  failed: number;
  expired: number;
}
interface MeshStatePayload {
  ok: true;
  version: number;
  plugin: string;
  generatedAt: number;
  transport: TransportReport;
  assignment: MeshStateAssignmentView;
  config: MeshStateConfigView;
  lifecycle: MeshLifecycleView;
  counts: MeshStateCounts;
  peers: Record<string, unknown>[];
  tasks: MeshStateTaskView[];
  notes: string[];
  /** Override file the settings page writes; empty when unknown. */
  configFile: string;
}
/** Newest tasks first, capped at MAX_TASK_ROWS. */
declare function recentTasks(tasks: readonly Task[], limit?: number): Task[];
/**
 * Build the settings-page payload. Pure read: it never mutates the board,
 * never dispatches, and degrades to notes when the transport is unavailable.
 */
declare function buildMeshState(runtime: MeshToolRuntime, now?: () => number, extras?: MeshStateExtras): Promise<MeshStatePayload>;
/** Minimal Context surface used here, kept duck-typed for unit tests. */
interface MeshRouteContext {
  get(name: string): unknown;
  inject?(deps: string[], callback: (inner: MeshRouteContext) => void): unknown;
}
/** Read-only snapshot endpoint polled by the settings page. */
declare const MESH_STATE_PATH = "/api/mesh/state";
/** Extras may be a constant or a getter, so hot-applied values stay fresh. */
type MeshStateExtrasSource = MeshStateExtras | (() => MeshStateExtras);
/** Serve the settings-page snapshot at /api/mesh/state. */
declare function registerMeshStateRoute(ctx: Context, runtime: MeshToolRuntime, extras?: MeshStateExtrasSource): void;
/**
 * Browser-writable configuration, served next to the read-only snapshot.
 *
 * Writes land in the plugin's own override file ($DSH_HOME/mesh-config.json)
 * because the native settings document does not project profile-patch mounted
 * entries. Lease fields and the assignment table apply to this process
 * immediately; transport selection and the peer URL need a restart because the
 * transport object is built during plugin apply.
 */
declare const MESH_CONFIG_PATH = "/api/mesh/config";
interface MeshConfigControl {
  /** Live runtime whose config/assignment the save mutates in place. */
  runtime: MeshToolRuntime;
  /** Override file the browser writes. */
  file: string;
  /** Values reported back with the refreshed snapshot. */
  extras: () => MeshStateExtras;
}
/** Fields that take effect without restarting the host process. */
declare const HOT_CONFIG_KEYS: readonly string[];
/** Fields persisted now but applied by the next plugin apply (container restart). */
declare const RESTART_CONFIG_KEYS: readonly string[];
/**
 * Validate and persist one config patch, then apply the hot subset.
 * @returns the HTTP reply: 400 for a rejected patch, 200 with the fresh state otherwise.
 */
declare function handleConfigSave(request: Request, control: MeshConfigControl): Promise<Response>;
/** Serve POST /api/mesh/config. */
declare function registerMeshConfigRoute(ctx: Context, control: MeshConfigControl): void;
/**
 * Browser-triggered dispatch, served next to the read-only snapshot.
 *
 * The model reaches the same code through the `mesh_dispatch` tool; this route
 * exists so a person can send a message to a remote workspace from the page
 * without waiting for a chat turn. It reuses the tool definition verbatim, so
 * validation, the lease invariant, the reply collector and the error vocabulary
 * cannot drift between the two entry points.
 */
declare const MESH_DISPATCH_PATH = "/api/mesh/dispatch";
interface MeshDispatchControl {
  runtime: MeshToolRuntime;
}
declare function handleDispatch(request: Request, control: MeshDispatchControl): Promise<Response>;
declare function registerMeshDispatchRoute(ctx: Context, runtime: MeshToolRuntime): void;
/**
 * This node's own native workspaces, for peers that want to list them.
 *
 * The mesh does not invent workspace ids: a remote caller must target the id the
 * owning DSH instance already knows, so the owner publishes its registry here and
 * the caller consumes it (see transport/typert.ts). Reading is all this route
 * does — creating or mutating a workspace stays a local, human action.
 */
declare const MESH_WORKSPACES_PATH = "/api/mesh/workspaces";
/** Shape of `ctx.workspaceRegistry` entries we depend on. */
interface RegistryWorkspace {
  id?: unknown;
  title?: unknown;
  path?: unknown;
  sessionIds?: unknown;
}
interface WorkspaceRegistryLike {
  list(): readonly RegistryWorkspace[];
  /** Present on the real registry; a read-only composition may omit it. */
  create?(path: string, title?: string): unknown;
}
interface MeshWorkspacesPayload {
  ok: true;
  workspaces: Array<{
    workspaceId: string;
    title: string;
    path: string;
    sessions: number;
    sessionIds: string[];
  }>;
  note?: string;
}
declare function buildWorkspacesPayload(registry: WorkspaceRegistryLike | undefined): MeshWorkspacesPayload;
/**
 * Read the registry without declaring a hard injection: mesh stays loadable in
 * compositions that do not mount the workspace domain.
 */
declare function readWorkspaceRegistry(ctx: unknown): WorkspaceRegistryLike | undefined;
declare function registerMeshWorkspacesRoute(ctx: Context, source: unknown): void;
/** One Assistant frame, already in the shape the browser folds. */
type LiveFrame = {
  readonly type: 'start';
  readonly attemptId: string;
  readonly revision: number;
  readonly startedAfterSeq: number;
  readonly turn: number;
  readonly step: number;
} | {
  readonly type: 'chunk';
  readonly attemptId: string;
  readonly revision: number;
  readonly index: number;
  readonly time: number;
  readonly chunk: unknown;
} | {
  readonly type: 'end';
  readonly attemptId: string;
  readonly revision: number;
  readonly index: number;
  readonly outcome: {
    kind?: string;
    seq?: number;
    eventType?: string;
  };
};
/** What one reader gets back for "everything after revision N". */
interface LivePage {
  /** Highest revision this Session has produced so far. */
  readonly revision: number;
  /** Frames newer than the requested revision, oldest first. */
  readonly frames: readonly LiveFrame[];
}
/**
 * Rolling per-Session copy of the Agent's live frames.
 *
 * The Hub only listens: it never drives the Agent, and a Session with no Agent
 * simply has nothing to hand out.
 */
declare class AssistantLiveHub {
  private readonly streams;
  /**
   * @param ctx - any Host context; the listener is global so Agents on other fibers are seen too.
   */
  constructor(ctx: Context);
  private readonly dispose;
  /** Stop listening; the retained frames go with it. */
  release(): void;
  /**
   * Keep one frame for its Session.
   * @param payload - the Host's event payload.
   */
  private accept;
  /**
   * Read everything newer than one revision.
   * @param sessionId - the Session to read.
   * @param since - last revision the reader folded; 0 asks for the whole attempt.
   * @returns the current revision and the unseen frames.
   */
  read(sessionId: string, since: number): LivePage;
  /**
   * Whether a Session currently has live frames at all.
   * @param sessionId - the Session to check.
   * @returns true while an Agent is producing frames there.
   */
  has(sessionId: string): boolean;
}
/**
 * Read the tail of a remote session, for the page's conversation viewer.
 *
 * History lives on the owning machine; this route asks the transport for it and
 * never caches — the page polls, the peer is the only authority.
 */
declare const MESH_SESSION_PATH = "/api/mesh/session";
interface MeshSessionControl {
  runtime: MeshToolRuntime;
  /** Frames this Host retained for its own Sessions; absent on a headless build. */
  hub?: AssistantLiveHub;
}
declare function handleSessionRead(request: Request, control: MeshSessionControl): Promise<Response>;
declare function registerMeshSessionRoute(ctx: Context, runtime: MeshToolRuntime): void;
/** One page of a remote session's raw event log; the page assembles the transcript. */
declare const MESH_SESSION_EVENTS_PATH = "/api/mesh/session/events";
declare function handleSessionEvents(request: Request, control: MeshSessionControl): Promise<Response>;
/** Open a Session on the peer's machine inside the picked Workspace. */
declare const MESH_SESSION_OPEN_PATH = "/api/mesh/session/open";
/** Send one prompt into a Session that lives on the peer's machine. */
declare const MESH_SESSION_PROMPT_PATH = "/api/mesh/session/prompt";
declare function handleSessionOpen(request: Request, control: MeshSessionControl): Promise<Response>;
declare function handleSessionPrompt(request: Request, control: MeshSessionControl): Promise<Response>;
/** Mount the page-facing routes on one Connection-bearing context. */
declare function registerMeshSessionPageRoutes(ctx: Context, runtime: MeshToolRuntime, hub?: AssistantLiveHub): void;
/**
 * Browser-facing administration of a peer's workspaces.
 *
 * The sidebar's remote section needs two things the `mesh_*` tools do not offer:
 * the directory listing of a machine (to pick a folder there) and the right to
 * register a Workspace on it. Both run through the transport's control
 * capability, which presents the mesh secret to the peer's relay — this route
 * only validates the request and maps the outcome.
 *
 * It is not part of the task data plane: nothing here creates a Session or
 * carries a task. The five-method plane keeps its narrow shape.
 */
declare const MESH_REMOTE_PATH = "/api/mesh/remote";
interface MeshRemoteControl {
  runtime: MeshToolRuntime;
}
/**
 * Validate one administration call and hand it to the transport.
 * @param request - the browser's POST.
 * @param control - mesh runtime; its transport must offer the control capability.
 * @returns the peer's answer, or a mesh-shaped failure with HTTP 200.
 */
declare function handleRemote(request: Request, control: MeshRemoteControl): Promise<Response>;
declare function mountMeshRemoteRoute(ctx: MeshRouteContext, control: MeshRemoteControl): boolean;
/** Serve POST /api/mesh/remote inside Connection's authenticated fence. */
declare function registerMeshRemoteRoute(ctx: Context, runtime: MeshToolRuntime): void;
/** Replay guard: a nonce is honoured once inside the window. */
declare class NonceCache {
  private readonly windowMs;
  private readonly seen;
  constructor(windowMs?: number);
  /** @returns false when this nonce was already used inside the window. */
  claim(nonce: string, now?: number): boolean;
}
/**
 * Peer asks for a mesh credential.
 *
 * Authenticated by the shared `meshSecret` (HMAC over nodeId + timestamp + nonce),
 * not by the web login token: that is what lets a caller recover by itself after
 * the peer restarts and its login token rotates.
 */
declare const MESH_HANDSHAKE_PATH = "/api/mesh/handshake";
interface MeshHandshakeControl {
  /** Shared secret; undefined disables the route. */
  secret: () => string | undefined;
  nonces: NonceCache;
  now?: () => number;
}
declare function handleHandshake(request: Request, control: MeshHandshakeControl): Promise<Response>;
declare function registerMeshHandshakeRoute(ctx: Context, secret: () => string | undefined): void;
/**
 * Execute one session operation locally on behalf of a paired peer.
 *
 * This is the self-healing half of the transport: the caller never needs the
 * node's web login token (which rotates on every restart). It presents a mesh
 * token minted from the shared secret, and this node runs the operation against
 * its own services — so the agent loop and the files stay right here.
 *
 * Deliberately narrow: four operations, no arbitrary method dispatch.
 */
declare const MESH_RELAY_PATH = "/api/mesh/relay";
/** The native workspace registry as this route uses it. */
interface RelayWorkspaceRegistry {
  list(): readonly unknown[];
  create?(path: string, title?: string): unknown;
}
/**
 * The shape of `ctx.sessionController` as this plugin uses it.
 *
 * Measured against `@deepseek-ai/dsh-api-session-controller` 0.2.1-rc.5: the
 * service *is* the generated `session` namespace, so its signatures are the
 * remote ones, not the internal command controller's. `prompt`'s second
 * argument is the caller's `AbortSignal` (the source metadata is built inside
 * from `request.requestId`), and `list` takes an (unused) request first.
 * Passing a source object there is what produced
 * "signal.throwIfAborted is not a function".
 */
interface SessionControllerLike {
  list(request?: unknown, signal?: AbortSignal): Promise<unknown>;
  create(request: unknown): Promise<unknown>;
  prompt(request: unknown, signal?: AbortSignal): Promise<unknown>;
  page(request: unknown, signal?: AbortSignal): Promise<unknown>;
}
interface MeshRelayControl {
  secret: () => string | undefined;
  controller: () => SessionControllerLike | undefined;
  /** Native workspace registry payload; absent compositions report an empty list. */
  workspaces?: () => unknown;
  /** Native registry; a peer may create a Workspace here through relay. */
  registry?: () => RelayWorkspaceRegistry | undefined;
  /** This Host's retained live Assistant frames; absent on a composition without an Agent. */
  live?: () => AssistantLiveHub | undefined;
  now?: () => number;
}
declare function handleRelay(request: Request, control: MeshRelayControl): Promise<Response>;
/** Read `ctx.sessionController` without a hard injection. */
declare function readSessionController(ctx: unknown): SessionControllerLike | undefined;
declare function registerMeshRelayRoute(ctx: Context, source: unknown, secret: () => string | undefined, workspaces?: () => unknown, registry?: () => RelayWorkspaceRegistry | undefined, live?: () => AssistantLiveHub | undefined): void;
/**
 * Plugin-owned configuration overrides.
 *
 * This DSH version's settings document only projects entries rooted directly
 * in the profile's `include` fibre, so a profile-patch mounted entry (the way
 * this deployment mounts mesh) has no namespace and the native settings page
 * cannot edit it. The browser page therefore writes its own override file,
 * which is layered on top of the cordis entry config at apply time:
 *
 *   cordis entry config (profile patch)  ->  $DSH_HOME/mesh-config.json  ->  live config
 *
 * The file is best-effort state, not a service: a missing or malformed file
 * only ever falls back to the entry config.
 */
interface MeshConfigOverride {
  transport?: 'auto';
  peers?: Array<{
    nodeId: string;
    baseUrl: string;
    token: string;
  }>;
  meshSecret?: string;
  assignmentFile?: string;
  leaseMs?: number;
  dispatchTimeoutMs?: number;
  leaseOwner?: string;
}
/** Override file path: explicit, else $DSH_HOME, else ~/.dsh. */
declare function meshConfigPath(explicit?: string): string;
interface SanitizeResult {
  value: MeshConfigOverride;
  problems: string[];
}
/** Validate one untrusted override object; unknown keys and bad types are problems. */
declare function sanitizeOverride(raw: unknown): SanitizeResult;
/** Read the override file; every failure mode degrades to "no overrides". */
declare function readConfigOverride(file?: string): MeshConfigOverride;
/** Merge a validated patch into the override file (atomic replace). */
declare function writeConfigOverride(patch: MeshConfigOverride, file?: string): MeshConfigOverride;
/**
 * Peer derivation shared by the mesh_list_nodes tool and the settings page
 * state route: assignment.yml entries and transport receipts merged into one
 * roster. Nothing here calls a DSH core roster API — there is none (spike
 * p1 §2.3) — so a node without a receipt stays "unknown" instead of online.
 */
type PeerStatus = 'online' | 'offline' | 'unknown';
type PeerSource = 'assignment' | 'transport' | 'both';
interface PeerWorkspaceView extends MeshWorkspaceView {}
interface PeerView {
  nodeId: string;
  label: string;
  endpoint: string;
  status: PeerStatus;
  source: PeerSource;
  lastSeenAt?: number;
  workspaces: PeerWorkspaceView[];
  assignedWorkspaceIds: string[];
}
interface RosterSnapshot {
  peers: PeerView[];
  notes: string[];
}
/** Wire shape consumed by the model tool and the settings page. */
declare function wirePeer(peer: PeerView): Record<string, unknown>;
/** Merge assignment.yml with transport receipts. Never throws: a failing transport becomes a note. */
declare function deriveRoster(runtime: MeshToolRuntime): Promise<RosterSnapshot>;
/**
 * Generate a ULID-shaped task id (SPEC §5.3: "taskId: ULID") without a
 * dependency: 10 base32 characters of millisecond time followed by 16
 * characters (80 bits) of randomness, 26 characters total.
 */
declare function createTaskId(now?: number, random?: (size: number) => Uint8Array): string;
/**
 * Register the P2 tool surface on the host tool runtime. `register` is itself an
 * effect in DSH, so disposal is automatic; the returned definitions let tests
 * assert exactly what the model will see.
 */
declare function registerMeshTools(host: MeshToolHost, runtime: MeshToolRuntime): MeshToolDefinition[];
/** Cordis registration name; mesh_status reports the same string (F-10). */
declare const name = "dsh-workspace-mesh";
/**
 * `tools` is required (without it cordis never injects the tool runtime, spike §2.1);
 * `webServer` is optional — the peer handshake/relay routes need a raw HTTP seat
 * below the browser fence, and a headless composition simply does not have one.
 */
declare const inject: {
  tools: boolean;
  webServer: null;
};
interface MeshConfig {
  /** Reserved for transport selection; 'auto' is the only value until an adapter ships. */
  transport?: 'auto';
  /** Peers reachable over their web API; empty = no cross-machine transport. */
  peers?: MeshPeerConfig[];
  /** Shared secret for peer handshakes; enables relay mode (no login token needed). */
  meshSecret?: string;
  /** Assignment table path (SPEC §5.4), resolved against the host process cwd. */
  assignmentFile?: string;
  /** Default lease TTL for a dispatched task. */
  leaseMs?: number;
  /** How long mesh_dispatch waits for a final reply before expiring the task. */
  dispatchTimeoutMs?: number;
  /** Task board lease owner recorded for dispatches made by these tools. */
  leaseOwner?: string;
}
interface ResolvedMeshConfig extends MeshConfig {
  transport: 'auto';
  leaseMs: number;
  dispatchTimeoutMs: number;
  leaseOwner: string;
}
interface MeshRuntime {
  lifecycle: LifecycleController;
  transport?: MeshTransport;
  /** Why transport selection degraded; surfaced by mesh_status/mesh_list_nodes. */
  transportError?: string;
  board: TaskBoard;
  assignment?: AssignmentTable;
  config: ResolvedMeshConfig;
}
declare function apply(ctx: Context, rawConfig?: MeshConfig): void;
export { AssignmentFileError, type AssignmentNode, type AssignmentRoute, type AssignmentTable, Config, type Config as MeshConfigSchema, HOT_CONFIG_KEYS, type LifecycleController, type LifecycleStatus, MAX_TASK_ROWS, MESH_CONFIG_PATH, MESH_DISPATCH_PATH, MESH_HANDSHAKE_PATH, MESH_RELAY_PATH, MESH_REMOTE_PATH, MESH_SESSION_EVENTS_PATH, MESH_SESSION_OPEN_PATH, MESH_SESSION_PATH, MESH_SESSION_PROMPT_PATH, MESH_STATE_PATH, MESH_STATE_VERSION, MESH_WORKSPACES_PATH, MeshConfig, type MeshConfigControl, type MeshConfigOverride, MeshRuntime, type MeshStateCounts, type MeshStatePayload, type MeshStateTaskView, type MeshToolConfig, type MeshToolDefinition, type MeshToolRuntime, type MeshTransport, type NodeDescriptor, type PeerSource, type PeerStatus, type PeerView, RESTART_CONFIG_KEYS, ResolvedMeshConfig, type RosterSnapshot, type Task, type TaskState, type WorkspaceSummary, apply, buildMeshState, buildWorkspacesPayload, createSelfRestartController, createTaskId, deriveRoster, detectSupervisor, findAssignmentNode, findAssignmentRoute, handleConfigSave, handleDispatch, handleHandshake, handleRelay, handleRemote, handleSessionEvents, handleSessionOpen, handleSessionPrompt, handleSessionRead, inject, loadAssignmentTable, meshConfigPath, mountMeshRemoteRoute, name, parseAssignment, readConfigOverride, readSessionController, readWorkspaceRegistry, recentTasks, registerMeshConfigRoute, registerMeshDispatchRoute, registerMeshHandshakeRoute, registerMeshRelayRoute, registerMeshRemoteRoute, registerMeshSessionPageRoutes, registerMeshSessionRoute, registerMeshStateRoute, registerMeshTools, registerMeshWorkspacesRoute, sanitizeOverride, wirePeer, writeConfigOverride };