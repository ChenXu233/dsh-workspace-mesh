import { mkdirSync, promises, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
// src/assignments/index.ts
var AssignmentFileError = class extends Error {
	file;
	line;
	code;
	constructor(file, line, code, detail) {
		super(line === void 0 ? `assignment file "${file}": ${detail}` : `assignment file "${file}" line ${line}: ${detail}`);
		this.name = "AssignmentFileError";
		this.file = file;
		this.line = line;
		this.code = code;
	}
};
const KNOWN_SECTIONS = /* @__PURE__ */ new Set(["nodes", "assignments"]);
const NODE_KEYS = /* @__PURE__ */ new Set(["label", "endpoint"]);
const ASSIGNMENT_KEYS = /* @__PURE__ */ new Set([
	"workspaceId",
	"nodeId",
	"cwd"
]);
/** Read and parse an assignment file. Path errors keep the absolute path in the message. */
function loadAssignmentTable(file) {
	const absolute = resolve(file);
	let text;
	try {
		text = readFileSync(absolute, "utf8");
	} catch (err) {
		const code = err.code;
		const detail = code === "ENOENT" ? "file not found" : `cannot read file (${err.message})`;
		throw new AssignmentFileError(absolute, void 0, code === "ENOENT" ? "missing-file" : "unreadable", detail);
	}
	return parseAssignment(text, absolute);
}
/** Parse assignment text. `file` is only used to build error messages. */
function parseAssignment(text, file = "<inline>") {
	const lines = tokenize(text, file);
	if (lines.length === 0) throw new AssignmentFileError(file, 1, "schema", "the file is empty; expected a \"nodes:\" and/or \"assignments:\" section");
	const nodes = [];
	const assignments = [];
	const nodeLines = /* @__PURE__ */ new Map();
	const workspaceLines = /* @__PURE__ */ new Map();
	const sections = /* @__PURE__ */ new Set();
	let index = 0;
	while (index < lines.length) {
		const line = lines[index];
		if (line.indent !== 0) throw new AssignmentFileError(file, line.number, "syntax", "unexpected indentation at the top level");
		const { key, value } = splitKeyValue(line, file);
		if (value !== "") throw new AssignmentFileError(file, line.number, "schema", `top-level section "${key}" must not have an inline value`);
		if (!KNOWN_SECTIONS.has(key)) throw new AssignmentFileError(file, line.number, "schema", `unknown top-level section "${key}" (supported: nodes, assignments)`);
		if (sections.has(key)) throw new AssignmentFileError(file, line.number, "schema", `duplicate section "${key}"`);
		sections.add(key);
		index += 1;
		index = key === "nodes" ? parseNodes(lines, index, file, nodes, nodeLines) : parseAssignments(lines, index, file, assignments, workspaceLines);
	}
	if (sections.size === 0) throw new AssignmentFileError(file, 1, "schema", "no \"nodes:\" or \"assignments:\" section found");
	return {
		file,
		nodes,
		assignments
	};
}
function findAssignmentNode(table, nodeId) {
	return table?.nodes.find((node) => node.nodeId === nodeId);
}
function findAssignmentRoute(table, workspaceId) {
	return table?.assignments.find((route) => route.workspaceId === workspaceId);
}
function tokenize(text, file) {
	const lines = [];
	const rawLines = text.replace(/^\uFEFF/u, "").split(/\r?\n/u);
	for (let index = 0; index < rawLines.length; index += 1) {
		const number = index + 1;
		const rightTrimmed = stripComment(rawLines[index] ?? "").replace(/\s+$/u, "");
		if (rightTrimmed.trim() === "") continue;
		const trimmed = rightTrimmed.trim();
		if (trimmed === "---" || trimmed === "...") continue;
		const leading = /^[ \t]*/u.exec(rightTrimmed)?.[0] ?? "";
		if (leading.includes("	")) throw new AssignmentFileError(file, number, "syntax", "tabs are not allowed in indentation; use spaces");
		lines.push({
			number,
			indent: leading.length,
			text: rightTrimmed.slice(leading.length)
		});
	}
	return lines;
}
function stripComment(line) {
	let quote;
	for (let index = 0; index < line.length; index += 1) {
		const char = line[index];
		if (quote !== void 0) {
			if (quote === "\"" && char === "\\") {
				index += 1;
				continue;
			}
			if (char === quote) quote = void 0;
			continue;
		}
		if (char === "\"" || char === "'") {
			quote = char;
			continue;
		}
		if (char === "#" && (index === 0 || /\s/u.test(line[index - 1]))) return line.slice(0, index);
	}
	return line;
}
function parseNodes(lines, start, file, nodes, nodeLines) {
	let index = start;
	let baseIndent;
	let current;
	const finish = () => {
		if (current === void 0) return;
		nodes.push({
			nodeId: current.nodeId,
			label: current.attrs.label,
			endpoint: current.attrs.endpoint,
			line: current.line
		});
		current = void 0;
	};
	while (index < lines.length) {
		const line = lines[index];
		if (line.indent === 0) break;
		if (baseIndent === void 0) baseIndent = line.indent;
		if (current !== void 0) {
			if (line.indent <= current.indent) {
				finish();
				continue;
			}
			if (current.attrIndent === void 0) current.attrIndent = line.indent;
			else if (current.attrIndent !== line.indent) throw new AssignmentFileError(file, line.number, "syntax", "inconsistent indentation inside a node entry");
			const { key, value } = splitKeyValue(line, file);
			if (!NODE_KEYS.has(key)) throw new AssignmentFileError(file, line.number, "schema", `unknown node key "${key}" (supported: label, endpoint)`);
			if (Object.hasOwn(current.attrs, key)) throw new AssignmentFileError(file, line.number, "schema", `duplicate node key "${key}"`);
			if (value === "") throw new AssignmentFileError(file, line.number, "schema", `node key "${key}" needs a value`);
			current.attrs[key] = unquote(value, file, line.number);
			index += 1;
			continue;
		}
		if (line.indent !== baseIndent) throw new AssignmentFileError(file, line.number, "syntax", `expected a node entry indented ${baseIndent} spaces`);
		if (line.text.startsWith("-")) throw new AssignmentFileError(file, line.number, "syntax", "nodes must be a mapping (\"nodeId: { label, endpoint }\"), not a sequence");
		const { key: nodeId, value } = splitKeyValue(line, file);
		if (nodeId === "") throw new AssignmentFileError(file, line.number, "schema", "node id must not be empty");
		const firstLine = nodeLines.get(nodeId);
		if (firstLine !== void 0) throw new AssignmentFileError(file, line.number, "schema", `duplicate node "${nodeId}" (first declared at line ${firstLine})`);
		nodeLines.set(nodeId, line.number);
		if (value === "") {
			current = {
				nodeId,
				line: line.number,
				indent: line.indent,
				attrs: {}
			};
			index += 1;
			continue;
		}
		const attrs = parseFlowMapping(value, line.number, file, NODE_KEYS, "node");
		nodes.push({
			nodeId,
			label: attrs.label,
			endpoint: attrs.endpoint,
			line: line.number
		});
		index += 1;
	}
	finish();
	return index;
}
function parseAssignments(lines, start, file, assignments, workspaceLines) {
	let index = start;
	let baseIndent;
	while (index < lines.length) {
		const line = lines[index];
		if (line.indent === 0) break;
		if (baseIndent === void 0) baseIndent = line.indent;
		if (line.indent !== baseIndent) throw new AssignmentFileError(file, line.number, "syntax", `expected an assignment entry indented ${baseIndent} spaces`);
		if (!line.text.startsWith("-")) throw new AssignmentFileError(file, line.number, "syntax", "assignment entries must start with \"-\"");
		const itemLine = line.number;
		const after = line.text.slice(1).trim();
		const attrs = {};
		let attrIndent;
		let inlineOnly = false;
		index += 1;
		if (after.startsWith("{")) {
			inlineOnly = true;
			Object.assign(attrs, parseFlowMapping(after, itemLine, file, ASSIGNMENT_KEYS, "assignment"));
		} else if (after !== "") {
			if (indexOutsideQuotes(after, ",", file, itemLine) >= 0) throw new AssignmentFileError(file, itemLine, "syntax", "inline assignment fields must be wrapped in { ... } when they share a line");
			const entry = splitKeyValue({
				number: itemLine,
				indent: line.indent,
				text: after
			}, file);
			if (!ASSIGNMENT_KEYS.has(entry.key)) throw new AssignmentFileError(file, itemLine, "schema", `unknown assignment key "${entry.key}" (supported: workspaceId, nodeId, cwd)`);
			if (entry.value === "") throw new AssignmentFileError(file, itemLine, "schema", `assignment key "${entry.key}" needs a value`);
			attrs[entry.key] = unquote(entry.value, file, itemLine);
		}
		while (index < lines.length && lines[index].indent > baseIndent) {
			const attribute = lines[index];
			if (inlineOnly) throw new AssignmentFileError(file, attribute.number, "syntax", "an inline assignment mapping cannot be followed by indented fields");
			if (attrIndent === void 0) attrIndent = attribute.indent;
			else if (attrIndent !== attribute.indent) throw new AssignmentFileError(file, attribute.number, "syntax", "inconsistent indentation inside an assignment entry");
			const { key, value } = splitKeyValue(attribute, file);
			if (!ASSIGNMENT_KEYS.has(key)) throw new AssignmentFileError(file, attribute.number, "schema", `unknown assignment key "${key}" (supported: workspaceId, nodeId)`);
			if (Object.hasOwn(attrs, key)) throw new AssignmentFileError(file, attribute.number, "schema", `duplicate assignment key "${key}"`);
			if (value === "") throw new AssignmentFileError(file, attribute.number, "schema", `assignment key "${key}" needs a value`);
			attrs[key] = unquote(value, file, attribute.number);
			index += 1;
		}
		const workspaceId = attrs.workspaceId;
		const nodeId = attrs.nodeId;
		if (workspaceId === void 0 || workspaceId === "") throw new AssignmentFileError(file, itemLine, "schema", "assignment needs a non-empty workspaceId");
		if (nodeId === void 0 || nodeId === "") throw new AssignmentFileError(file, itemLine, "schema", "assignment needs a non-empty nodeId");
		const firstLine = workspaceLines.get(workspaceId);
		if (firstLine !== void 0) throw new AssignmentFileError(file, itemLine, "schema", `workspace "${workspaceId}" is assigned more than once (first at line ${firstLine}); remove the duplicate or pass nodeId explicitly at dispatch time`);
		workspaceLines.set(workspaceId, itemLine);
		const cwd = attrs.cwd;
		assignments.push({
			workspaceId,
			nodeId,
			...cwd === void 0 || cwd === "" ? {} : { cwd },
			line: itemLine
		});
	}
	return index;
}
function parseFlowMapping(raw, lineNumber, file, allowedKeys, kind) {
	const value = raw.trim();
	if (!value.startsWith("{")) throw new AssignmentFileError(file, lineNumber, "syntax", `${kind} value must be an inline mapping "{ ... }"`);
	if (!value.endsWith("}")) throw new AssignmentFileError(file, lineNumber, "syntax", "unterminated inline mapping");
	const inner = value.slice(1, -1).trim();
	const attrs = {};
	if (inner === "") return attrs;
	const parts = splitOutsideQuotes(inner, ",", file, lineNumber);
	for (let index = 0; index < parts.length; index += 1) {
		const text = parts[index].trim();
		if (text === "") {
			if (index === parts.length - 1) continue;
			throw new AssignmentFileError(file, lineNumber, "syntax", "empty entry in an inline mapping");
		}
		const { key, value: rawValue } = splitKeyValue({
			number: lineNumber,
			indent: 0,
			text
		}, file);
		if (!allowedKeys.has(key)) throw new AssignmentFileError(file, lineNumber, "schema", `unknown ${kind} key "${key}" (supported: ${[...allowedKeys].join(", ")})`);
		if (Object.hasOwn(attrs, key)) throw new AssignmentFileError(file, lineNumber, "schema", `duplicate ${kind} key "${key}"`);
		if (rawValue === "") throw new AssignmentFileError(file, lineNumber, "schema", `${kind} key "${key}" needs a value`);
		if (rawValue.startsWith("{") || rawValue.startsWith("[")) throw new AssignmentFileError(file, lineNumber, "schema", "nested flow collections are not supported");
		attrs[key] = unquote(rawValue, file, lineNumber);
	}
	return attrs;
}
function splitKeyValue(line, file) {
	const colon = indexOutsideQuotes(line.text, ":", file, line.number);
	if (colon < 0) throw new AssignmentFileError(file, line.number, "syntax", "expected \"key: value\"");
	const rawKey = line.text.slice(0, colon).trim();
	if (rawKey === "") throw new AssignmentFileError(file, line.number, "syntax", "empty key");
	return {
		key: unquote(rawKey, file, line.number),
		value: line.text.slice(colon + 1).trim()
	};
}
function indexOutsideQuotes(input, target, file, lineNumber) {
	let quote;
	for (let index = 0; index < input.length; index += 1) {
		const char = input[index];
		if (quote !== void 0) {
			if (quote === "\"" && char === "\\") {
				index += 1;
				continue;
			}
			if (char === quote) {
				if (quote === "'" && input[index + 1] === "'") {
					index += 1;
					continue;
				}
				quote = void 0;
			}
			continue;
		}
		if (char === "\"" || char === "'") {
			quote = char;
			continue;
		}
		if (char === target) return index;
	}
	if (quote !== void 0) throw new AssignmentFileError(file, lineNumber, "syntax", "unterminated quoted string");
	return -1;
}
function splitOutsideQuotes(input, separator, file, lineNumber) {
	const parts = [];
	let current = "";
	let quote;
	for (let index = 0; index < input.length; index += 1) {
		const char = input[index];
		if (quote !== void 0) {
			current += char;
			if (quote === "\"" && char === "\\") {
				index += 1;
				current += input[index] ?? "";
				continue;
			}
			if (char === quote) {
				if (quote === "'" && input[index + 1] === "'") {
					index += 1;
					current += input[index] ?? "";
					continue;
				}
				quote = void 0;
			}
			continue;
		}
		if (char === "\"" || char === "'") {
			quote = char;
			current += char;
			continue;
		}
		if (char === separator) {
			parts.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	if (quote !== void 0) throw new AssignmentFileError(file, lineNumber, "syntax", "unterminated quoted string");
	parts.push(current);
	return parts;
}
function unquote(raw, file, lineNumber) {
	const value = raw.trim();
	if (value === "") throw new AssignmentFileError(file, lineNumber, "schema", "empty value");
	if (value.startsWith("\"")) {
		if (value.length < 2 || !value.endsWith("\"")) throw new AssignmentFileError(file, lineNumber, "syntax", "unterminated double-quoted string");
		const inner = value.slice(1, -1);
		let out = "";
		for (let index = 0; index < inner.length; index += 1) {
			const char = inner[index];
			if (char === "\"") throw new AssignmentFileError(file, lineNumber, "syntax", "unescaped double quote inside a double-quoted string");
			if (char !== "\\") {
				out += char;
				continue;
			}
			index += 1;
			const escape = inner[index];
			if (escape === void 0) throw new AssignmentFileError(file, lineNumber, "syntax", "trailing backslash in a double-quoted string");
			const mapped = {
				"\"": "\"",
				"\\": "\\",
				"/": "/",
				n: "\n",
				t: "	",
				r: "\r",
				b: "\b",
				f: "\f",
				"0": "\0"
			}[escape];
			if (mapped === void 0) throw new AssignmentFileError(file, lineNumber, "syntax", `unsupported escape "\\${escape}"`);
			out += mapped;
		}
		return out;
	}
	if (value.startsWith("'")) {
		if (value.length < 2 || !value.endsWith("'")) throw new AssignmentFileError(file, lineNumber, "syntax", "unterminated single-quoted string");
		return value.slice(1, -1).replace(/''/gu, "'");
	}
	if (value.startsWith("{") || value.startsWith("[")) throw new AssignmentFileError(file, lineNumber, "schema", "nested flow collections are not supported in scalar values");
	if (/^[&*!|>]/u.test(value)) throw new AssignmentFileError(file, lineNumber, "schema", "YAML anchors, aliases, tags and block scalars are not supported; use a plain scalar");
	return value;
}
// src/board/index.ts
function copyTask(task) {
	return {
		...task,
		target: { ...task.target },
		lease: { ...task.lease }
	};
}
function isLive(lease, at) {
	return lease.owner !== "" && lease.expiresAt > at;
}
function isTerminal(state) {
	return state === "done" || state === "failed" || state === "expired";
}
function sessionKeyOf(task) {
	if (task.policy.sessionMode !== "resume" || task.policy.sessionId === void 0) return void 0;
	return `${task.target.nodeId}\u0000${task.policy.sessionId}`;
}
function createInMemoryBoard(now = Date.now) {
	const tasks = /* @__PURE__ */ new Map();
	/** sessionKey -> taskId; entries are validated against a live lease on read. */
	const sessions = /* @__PURE__ */ new Map();
	const activeSessionHolder = (sessionKey, at) => {
		const taskId = sessions.get(sessionKey);
		if (taskId === void 0) return void 0;
		const task = tasks.get(taskId);
		if (task === void 0 || !isLive(task.lease, at)) {
			sessions.delete(sessionKey);
			return;
		}
		return taskId;
	};
	const releaseSession = (taskId) => {
		for (const [key, owner] of sessions) if (owner === taskId) sessions.delete(key);
	};
	const claimSession = (taskId, sessionKey, at) => {
		const holder = activeSessionHolder(sessionKey, at);
		if (holder !== void 0 && holder !== taskId) return false;
		sessions.set(sessionKey, taskId);
		return true;
	};
	return {
		create(task) {
			if (tasks.has(task.taskId)) return false;
			tasks.set(task.taskId, copyTask(task));
			return true;
		},
		get(taskId) {
			const task = tasks.get(taskId);
			return task ? copyTask(task) : void 0;
		},
		update(taskId, patch, fence) {
			const current = tasks.get(taskId);
			if (!current) return false;
			const at = now();
			if (fence !== void 0) {
				if (!isLive(current.lease, at)) return false;
				if (current.lease.owner !== fence.owner || current.lease.fencingToken !== fence.fencingToken) return false;
			}
			const { taskId: _ignoredId, lease: _ignoredLease, ...rest } = patch;
			tasks.set(taskId, {
				...current,
				...rest,
				taskId: current.taskId,
				updatedAt: at
			});
			if (rest.state !== void 0 && isTerminal(rest.state)) releaseSession(taskId);
			return true;
		},
		list(filter) {
			const all = [...tasks.values()];
			return (filter ? all.filter((task) => (filter.state === void 0 || task.state === filter.state) && (filter.nodeId === void 0 || task.target.nodeId === filter.nodeId)) : all).map(copyTask);
		},
		claim(taskId, owner, ttlMs, options) {
			if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError(`lease ttlMs must be a positive finite number, got ${ttlMs}`);
			if (owner === "") throw new RangeError("lease owner must be a non-empty string");
			const task = tasks.get(taskId);
			if (!task) return false;
			const at = now();
			const current = task.lease;
			const live = isLive(current, at);
			if (live && current.owner !== owner) return false;
			const fencingToken = live && current.owner === owner ? current.fencingToken : current.fencingToken + 1;
			const sessionKey = options?.sessionKey ?? sessionKeyOf(task);
			if (sessionKey !== void 0 && !claimSession(taskId, sessionKey, at)) return false;
			tasks.set(taskId, {
				...task,
				lease: {
					owner,
					fencingToken,
					expiresAt: at + ttlMs
				},
				updatedAt: at
			});
			return true;
		},
		bindSession(taskId, sessionKey) {
			const task = tasks.get(taskId);
			if (task === void 0) return false;
			const at = now();
			if (!isLive(task.lease, at)) return false;
			return claimSession(taskId, sessionKey, at);
		},
		sessionOwner(sessionKey) {
			return activeSessionHolder(sessionKey, now());
		},
		release(taskId, owner) {
			const task = tasks.get(taskId);
			if (!task) return false;
			if (owner !== void 0 && task.lease.owner !== owner) return false;
			tasks.set(taskId, {
				...task,
				lease: {
					owner: "",
					fencingToken: task.lease.fencingToken,
					expiresAt: 0
				},
				updatedAt: now()
			});
			releaseSession(taskId);
			return true;
		}
	};
}
// src/lifecycle/index.ts
function detectSupervisor() {
	const env = process.env;
	if (env.INVOCATION_ID || env.JOURNAL_STREAM) return "systemd";
	if (env.container || env.DOCKER_CONTAINER_ID || env.KUBERNETES_SERVICE_HOST) return "docker";
	if (env.pm_id !== void 0) return "pm2";
	return "unknown";
}
function createSelfRestartController(options = {}) {
	const now = options.now ?? Date.now;
	const exit = options.exit ?? ((code) => process.exit(code));
	const drainTimeoutMs = options.drainTimeoutMs ?? 5e3;
	const startedAt = now();
	const pid = options.pid ?? process.pid;
	let state = "running";
	const listeners = /* @__PURE__ */ new Set();
	return {
		status: () => ({
			state,
			pid,
			startedAt,
			supervisor: detectSupervisor()
		}),
		onDrain(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		requestRestart(reason) {
			if (state !== "running") return;
			state = "draining";
			const drain = Promise.allSettled([...listeners].map((fn) => fn()));
			const timeout = new Promise((resolve) => setTimeout(resolve, drainTimeoutMs).unref?.());
			Promise.race([drain, timeout]).then(() => {
				state = "offline";
				console.info(`[mesh] restarting (${reason}); supervisor=${detectSupervisor()}`);
				exit(0);
			});
		}
	};
}
// src/api/mesh-auth.ts
/**
* Mesh credentials: a shared secret turns into short-lived bearer tokens.
*
* Why this exists: the only cross-machine door DSH offers today is the web login
* token, and that rotates on every peer restart — so a caller has to be handed a
* new one by a human each time. A shared secret that both sides already hold
* removes that: the caller asks for a token, the peer mints one, and both sides
* can re-derive it after any restart without operator input.
*
* Scope: the token authorizes exactly one route (`/api/mesh/relay`), never the
* core `/api` surface. That keeps the blast radius to "what the mesh can do",
* not "everything the owner can do".
*/
/** Tokens live 10 minutes; the caller renews on demand. */
const MESH_TOKEN_TTL_MS = 6e5;
/** Clock skew allowed when verifying a handshake timestamp. */
const MESH_HANDSHAKE_WINDOW_MS = 6e4;
function base64url(input) {
	return Buffer.from(input).toString("base64url");
}
function hmac(secret, payload) {
	return createHmac("sha256", secret).update(payload).digest("base64url");
}
function constantTimeEqual(a, b) {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}
/** `<payload>.<signature>`, both base64url. */
function mintMeshToken(secret, claims) {
	const payload = base64url(JSON.stringify(claims));
	return `${payload}.${hmac(secret, payload)}`;
}
function verifyMeshToken(secret, token, now = Date.now()) {
	if (typeof token !== "string" || !token.includes(".")) return {
		ok: false,
		reason: "malformed"
	};
	const [payload, signature] = token.split(".");
	if (payload === void 0 || signature === void 0) return {
		ok: false,
		reason: "malformed"
	};
	if (!constantTimeEqual(hmac(secret, payload), signature)) return {
		ok: false,
		reason: "signature"
	};
	let claims;
	try {
		claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
	} catch {
		return {
			ok: false,
			reason: "malformed"
		};
	}
	if (typeof claims.nodeId !== "string" || typeof claims.expiresAt !== "number") return {
		ok: false,
		reason: "malformed"
	};
	if (claims.expiresAt <= now) return {
		ok: false,
		reason: "expired"
	};
	return {
		ok: true,
		claims
	};
}
function signHandshake(secret, request) {
	return hmac(secret, `mesh-handshake:${request.nodeId}:${request.ts}:${request.nonce}`);
}
/** Replay guard: a nonce is honoured once inside the window. */
var NonceCache = class {
	windowMs;
	seen = /* @__PURE__ */ new Map();
	constructor(windowMs = MESH_HANDSHAKE_WINDOW_MS) {
		this.windowMs = windowMs;
	}
	/** @returns false when this nonce was already used inside the window. */
	claim(nonce, now = Date.now()) {
		for (const [key, expiresAt] of this.seen) if (expiresAt <= now) this.seen.delete(key);
		if (this.seen.has(nonce)) return false;
		this.seen.set(nonce, now + this.windowMs);
		return true;
	}
};
function verifyHandshake(secret, body, nonces, now = Date.now()) {
	if (typeof body !== "object" || body === null) return {
		ok: false,
		reason: "malformed"
	};
	const record = body;
	const nodeId = record.nodeId;
	const ts = record.ts;
	const nonce = record.nonce;
	const hmacValue = record.hmac;
	if (typeof nodeId !== "string" || nodeId === "") return {
		ok: false,
		reason: "malformed"
	};
	if (typeof ts !== "number" || !Number.isFinite(ts)) return {
		ok: false,
		reason: "malformed"
	};
	if (typeof nonce !== "string" || nonce.length < 8) return {
		ok: false,
		reason: "malformed"
	};
	if (typeof hmacValue !== "string") return {
		ok: false,
		reason: "malformed"
	};
	if (Math.abs(now - ts) > 6e4) return {
		ok: false,
		reason: "stale"
	};
	if (!constantTimeEqual(signHandshake(secret, {
		nodeId,
		ts,
		nonce
	}), hmacValue)) return {
		ok: false,
		reason: "signature"
	};
	if (!nonces.claim(nonce, now)) return {
		ok: false,
		reason: "nonce-reused"
	};
	return { ok: true };
}
// src/transport/types.ts
/** What an adapter throws when it cannot do its job — never return fake data instead. */
var TransportUnavailableError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "TransportUnavailableError";
	}
};
// src/transport/typert.ts
/** Error carrying the mesh error code the tool layer maps onto its vocabulary. */
var TypertRpcError = class extends Error {
	code;
	/**
	* True when the call never produced an answer (socket reset, proxy 5xx). A
	* read may be replayed once; a create or a prompt may not.
	*/
	transient;
	constructor(code, message, transient = false) {
		super(message);
		this.name = "TypertRpcError";
		this.code = code;
		this.transient = transient;
	}
};
/** Readable one-liner for a fetch failure, including undici's `cause` code. */
function describeError(err) {
	if (!(err instanceof Error)) return String(err);
	const cause = err.cause;
	const code = typeof cause?.code === "string" ? cause.code : "";
	return code === "" ? err.message : `${err.message} (${code})`;
}
/**
* Ops that may be replayed after a transport failure. `create` and `prompt`
* change peer state, so they are never retried: a duplicate prompt is a
* duplicate turn.
*/
const IDEMPOTENT_OPS = /* @__PURE__ */ new Set([
	"list",
	"page",
	"workspaces"
]);
const MAX_PAGE_WALK = 20;
/** Concatenate the text parts of a message payload, ignoring images and files. */
function partsToText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const record = block;
		if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
	}
	return parts.join("").trim();
}
let requestCounter = 0;
function nextRequestId(prefix) {
	requestCounter += 1;
	return `${prefix}-${Date.now().toString(36)}-${requestCounter}`;
}
/** Map a gateway error code onto the mesh vocabulary used by toMeshError(). */
function mapGatewayCode(code, message) {
	const raw = code ?? "";
	if (/access|denied|forbidden|unauthorized/i.test(raw) || /access denied|unauthorized/i.test(message)) return "forbidden";
	if (/unknown-session|session\/not-found/i.test(raw)) return "unknown-session";
	if (/unknown-workspace|workspace\/not-found/i.test(raw)) return "unknown-workspace";
	if (/timeout|aborted/i.test(raw)) return "timeout";
	if (/arguments-invalid/i.test(raw)) return "bad-target";
	return "remote-failure";
}
/** RPC method → relay op. Relay mode serves exactly these. */
const METHOD_TO_OP = {
	"session/list": "list",
	"session/create": "create",
	"session/prompt": "prompt",
	"session/page": "page"
};
var TypertClient = class {
	peer;
	fetchImpl;
	onFailure;
	coolingDown;
	meshSecret;
	cookie;
	meshToken;
	constructor(peer, fetchImpl, onFailure = () => {}, coolingDown = () => false, meshSecret = "") {
		this.peer = peer;
		this.fetchImpl = fetchImpl;
		this.onFailure = onFailure;
		this.coolingDown = coolingDown;
		this.meshSecret = meshSecret;
	}
	get relayMode() {
		return this.meshSecret !== "";
	}
	/** Ask the peer for a mesh token, reusing it until shortly before expiry. */
	async ensureMeshToken() {
		const current = this.meshToken;
		if (current !== void 0 && current.expiresAt - 3e4 > Date.now()) return current.token;
		const ts = Date.now();
		const nonce = `${ts}-${Math.random().toString(36).slice(2, 10)}`;
		const hmac = signHandshake(this.meshSecret, {
			nodeId: this.peer.nodeId,
			ts,
			nonce
		});
		const res = await this.fetchImpl(this.url("/api/mesh/handshake"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				nodeId: this.peer.nodeId,
				ts,
				nonce,
				hmac
			})
		});
		if (!res.ok) throw new TypertRpcError("forbidden", `peer ${this.peer.nodeId}: handshake refused (HTTP ${res.status}); check meshSecret`);
		const body = await res.json();
		if (typeof body.token !== "string" || body.token === "") throw new TypertRpcError("remote-failure", `peer ${this.peer.nodeId}: handshake returned no token`);
		this.meshToken = {
			token: body.token,
			expiresAt: typeof body.expiresAt === "number" ? body.expiresAt : Date.now() + 6e5
		};
		return body.token;
	}
	/** Fetch that reports a socket-level failure as a transient peer error. */
	async send(url, init) {
		try {
			return await this.fetchImpl(url, init);
		} catch (err) {
			throw new TypertRpcError("remote-failure", `peer ${this.peer.nodeId}: transport error (${describeError(err)})`, true);
		}
	}
	/** Read a JSON body; a connection reset mid-body is a transient failure, not an answer. */
	async readJson(res, what) {
		try {
			return await res.json();
		} catch (err) {
			throw new TypertRpcError("remote-failure", `peer ${this.peer.nodeId}: ${what} response was cut off (${describeError(err)})`, true);
		}
	}
	/**
	* One relay round trip.
	*
	* Three recoveries, in order of what they cost the peer:
	* - a 401 renews the mesh token once (it expires every ten minutes);
	* - a read whose connection died is replayed once — a busy peer takes seconds
	*   to answer `session/list`, and a keep-alive socket that closes under a slow
	*   request surfaces as ECONNRESET, not as a peer answer;
	* - anything else is reported as it happened.
	*/
	async relayOp(op, args) {
		this.assertNotCoolingDown(op);
		const attempt = async () => {
			const send = async () => {
				const token = await this.ensureMeshToken();
				return this.send(this.url("/api/mesh/relay"), {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						token,
						op,
						args
					})
				});
			};
			let res = await send();
			if (res.status === 401) {
				this.meshToken = void 0;
				res = await send();
			}
			if (res.status === 401) throw new TypertRpcError("forbidden", `peer ${this.peer.nodeId}: relay rejected the mesh token`);
			if (!res.ok) {
				const detail = await res.json().catch(() => void 0);
				const reason = typeof detail?.error === "string" && detail.error !== "" ? detail.error : `relay ${op} returned HTTP ${res.status}`;
				throw new TypertRpcError("remote-failure", `peer ${this.peer.nodeId}: ${reason}`, res.status >= 500);
			}
			const envelope = await this.readJson(res, `relay ${op}`);
			if (envelope.ok !== true) throw new TypertRpcError(mapGatewayCode(envelope.code, envelope.error ?? "relay failed"), `peer ${this.peer.nodeId}: ${envelope.error ?? "relay failed"}`);
			return envelope.value;
		};
		try {
			return await attempt();
		} catch (err) {
			if (err instanceof TypertRpcError && err.transient && IDEMPOTENT_OPS.has(op)) return attempt();
			throw err;
		}
	}
	assertNotCoolingDown(path) {
		if (this.coolingDown()) throw new TypertRpcError("node-offline", `peer ${this.peer.nodeId}: cooling down after a failure, ${path} skipped`);
	}
	url(path) {
		return `${this.peer.baseUrl.replace(/\/+$/, "")}${path}`;
	}
	/** Exchange the login token for a signed API cookie (cached per client). */
	async connect() {
		if (this.cookie !== void 0) return this.cookie;
		this.assertNotCoolingDown("/connect");
		const target = `${this.url("/connect")}?token=${encodeURIComponent(this.peer.token)}&interactions=none`;
		const res = await this.fetchImpl(target, { redirect: "manual" });
		const cookie = (typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [res.headers.get("set-cookie")].filter((value) => typeof value === "string" && value !== "")).map((value) => value.split(";")[0]).join("; ");
		if (cookie === "") throw new TypertRpcError("forbidden", `peer ${this.peer.nodeId}: /connect returned no credential (token stale?)`);
		this.cookie = cookie;
		return cookie;
	}
	/** Authenticated GET against the peer's own routes (not the Typert RPC surface). */
	async get(path) {
		this.assertNotCoolingDown(path);
		try {
			return await this.getOnce(path);
		} catch (err) {
			this.onFailure();
			throw err;
		}
	}
	async getOnce(path) {
		const cookie = await this.connect();
		const res = await this.fetchImpl(this.url(path), { headers: {
			cookie,
			accept: "application/json"
		} });
		if (res.status === 401 || res.status === 403) {
			this.cookie = void 0;
			throw new TypertRpcError("forbidden", `peer ${this.peer.nodeId}: ${path} was rejected (HTTP ${res.status}); refresh the peer token`);
		}
		if (!res.ok) throw new TypertRpcError("remote-failure", `peer ${this.peer.nodeId}: ${path} returned HTTP ${res.status}`);
		return await res.json();
	}
	async call(method, args) {
		if (this.relayMode) {
			const op = METHOD_TO_OP[method];
			if (op === void 0) throw new TypertRpcError("remote-failure", `relay mode cannot serve "${method}"`);
			return this.relayOp(op, args);
		}
		this.assertNotCoolingDown(method);
		const isRead = IDEMPOTENT_OPS.has(METHOD_TO_OP[method] ?? "");
		const attempt = async () => {
			const cookie = await this.connect();
			const res = await this.send(this.url(`/api/${method}`), {
				method: "POST",
				headers: {
					"content-type": "application/json",
					cookie
				},
				body: JSON.stringify({
					type: "client-request",
					rpcId: nextRequestId(method),
					method,
					payload: { args }
				})
			});
			if (res.status === 401 || res.status === 403) {
				this.cookie = void 0;
				this.onFailure();
				throw new TypertRpcError("forbidden", `peer ${this.peer.nodeId}: ${method} was rejected (HTTP ${res.status}); refresh the peer token`);
			}
			if (!res.ok) throw new TypertRpcError("remote-failure", `peer ${this.peer.nodeId}: ${method} returned HTTP ${res.status}`, res.status >= 500);
			const result = (await this.readJson(res, method)).result;
			if (result === void 0) throw new TypertRpcError("remote-failure", `peer ${this.peer.nodeId}: ${method} returned no result envelope`);
			if (result.ok !== true) {
				const code = result.error?.code;
				const message = result.error?.message ?? "peer rejected the call";
				throw new TypertRpcError(mapGatewayCode(code, message), `peer ${this.peer.nodeId}: ${message}`);
			}
			return result.value;
		};
		try {
			return await attempt();
		} catch (err) {
			if (!(err instanceof TypertRpcError && (err.code === "forbidden" ? this.cookie === void 0 : err.transient && isRead))) {
				this.onFailure();
				throw err;
			}
			try {
				return await attempt();
			} catch (retried) {
				this.onFailure();
				throw retried;
			}
		}
	}
};
function createTypertTransport(options) {
	const fetchImpl = options.fetchImpl ?? fetch;
	const pollMs = options.pollMs ?? 1e3;
	const now = options.now ?? Date.now;
	const cooldownMs = options.failureCooldownMs ?? 6e4;
	/** Consecutive failures before a peer is left alone; one 401 may just be a stale cookie. */
	const FAILURES_BEFORE_COOLDOWN = 2;
	const blockedUntil = /* @__PURE__ */ new Map();
	const failureCount = /* @__PURE__ */ new Map();
	const coolingDown = (nodeId) => (blockedUntil.get(nodeId) ?? 0) > now();
	const noteFailure = (nodeId) => {
		const next = (failureCount.get(nodeId) ?? 0) + 1;
		failureCount.set(nodeId, next);
		if (next < FAILURES_BEFORE_COOLDOWN) return;
		const factor = Math.min(2 ** (next - FAILURES_BEFORE_COOLDOWN), 16);
		blockedUntil.set(nodeId, now() + cooldownMs * factor);
	};
	const noteSuccess = (nodeId) => {
		failureCount.delete(nodeId);
		blockedUntil.delete(nodeId);
	};
	const clients = /* @__PURE__ */ new Map();
	for (const peer of options.peers) clients.set(peer.nodeId, new TypertClient(peer, fetchImpl, () => noteFailure(peer.nodeId), () => coolingDown(peer.nodeId), options.meshSecret ?? ""));
	const requireClient = (nodeId) => {
		const client = clients.get(nodeId);
		if (client === void 0) throw new TypertRpcError("unknown-node", `no peer configured for node "${nodeId}"`);
		return client;
	};
	/** assignment.yml routes, used when the peer cannot report its own registry. */
	const workspacesOf = (nodeId) => (options.listAssigned?.(nodeId) ?? []).map((route) => ({
		workspaceId: route.workspaceId,
		name: route.workspaceId,
		path: route.cwd,
		sessions: []
	}));
	const workspacesPath = options.workspacesPath ?? "/api/mesh/workspaces";
	/** Native workspace ids seen per node: the only ids the peer's session/create accepts. */
	const nativeIds = /* @__PURE__ */ new Map();
	const fetchNativeWorkspaces = async (client, nodeId) => {
		try {
			const items = (client.relayMode ? await client.relayOp("workspaces", {}) : await client.get(workspacesPath)).workspaces;
			if (!Array.isArray(items)) return void 0;
			let rows = [];
			try {
				rows = await listSessions(client);
			} catch {
				rows = [];
			}
			const byId = /* @__PURE__ */ new Map();
			for (const row of rows) if (typeof row.sessionId === "string") byId.set(row.sessionId, row);
			const ids = /* @__PURE__ */ new Set();
			const accounted = /* @__PURE__ */ new Set();
			const toSession = (sessionId) => {
				const row = byId.get(sessionId);
				return {
					sessionId,
					title: row?.projections?.values?.title ?? "",
					updatedAt: typeof row?.updatedAt === "number" ? row.updatedAt : 0,
					busy: row?.running === true
				};
			};
			const workspaces = items.filter((item) => typeof item.workspaceId === "string" && item.workspaceId !== "").map((item) => {
				const workspaceId = String(item.workspaceId);
				ids.add(workspaceId);
				const sessionIds = Array.isArray(item.sessionIds) ? item.sessionIds.map(String) : [];
				for (const sessionId of sessionIds) accounted.add(sessionId);
				return {
					workspaceId,
					name: item.title !== void 0 && item.title !== "" ? item.title : workspaceId,
					path: item.path ?? "",
					sessions: sessionIds.map(toSession)
				};
			});
			const byCwd = /* @__PURE__ */ new Map();
			for (const row of rows) {
				const sessionId = row.sessionId;
				if (typeof sessionId !== "string" || accounted.has(sessionId)) continue;
				const cwd = typeof row.cwd === "string" && row.cwd !== "" ? row.cwd : "";
				const list = byCwd.get(cwd);
				if (list === void 0) byCwd.set(cwd, [sessionId]);
				else list.push(sessionId);
			}
			for (const [cwd, sessionIds] of byCwd) {
				const owner = workspaces.find((workspace) => cwd !== "" && workspace.path === cwd);
				if (owner !== void 0) {
					const seen = new Set(owner.sessions.map((session) => session.sessionId));
					for (const sessionId of sessionIds) if (!seen.has(sessionId)) owner.sessions.push(toSession(sessionId));
					continue;
				}
				const pseudoId = cwd === "" ? "cwd:" : `cwd:${cwd}`;
				ids.add(pseudoId);
				workspaces.push({
					workspaceId: pseudoId,
					name: cwd === "" ? "(no workspace)" : cwd.split("/").filter(Boolean).pop() ?? cwd,
					path: cwd,
					sessions: sessionIds.map(toSession)
				});
			}
			for (const workspace of workspaces) workspace.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
			nativeIds.set(nodeId, ids);
			noteSuccess(nodeId);
			return workspaces;
		} catch {
			return;
		}
	};
	const resolveWorkspaces = async (nodeId) => {
		const client = requireClient(nodeId);
		return await fetchNativeWorkspaces(client, nodeId) ?? workspacesOf(nodeId);
	};
	/** session/list tolerates the "_request" carrier; retry once if a peer rejects it. */
	const listSessions = async (client) => {
		try {
			return (await client.call("session/list", { _request: {} })).items ?? [];
		} catch (err) {
			if (err instanceof TypertRpcError && err.code === "bad-target") return (await client.call("session/list", {})).items ?? [];
			throw err;
		}
	};
	const findRow = (rows, sessionId) => rows.find((row) => row.sessionId === sessionId);
	/** Events up to `throughSeq`, keeping only those after `sinceSeq`, oldest first. */
	const readEvents = async (client, sessionId, throughSeq, sinceSeq) => {
		const collected = [];
		let through = throughSeq;
		let beforeSeq;
		for (let walk = 0; walk < MAX_PAGE_WALK; walk += 1) {
			const request = {
				address: {
					kind: "session",
					sessionId
				},
				throughSeq: through,
				maxMessages: 200
			};
			if (beforeSeq !== void 0) request.beforeSeq = beforeSeq;
			const value = await client.call("session/page", { request });
			const events = (value.records ?? []).map((record) => record.event ?? record).filter((event) => typeof event.seq === "number");
			collected.push(...events);
			if (value.hasMore !== true || events.length === 0) break;
			const oldest = Math.min(...events.map((event) => event.seq));
			if (oldest <= sinceSeq + 1) break;
			beforeSeq = oldest;
			through = oldest;
		}
		return collected.filter((event) => event.seq > sinceSeq).sort((a, b) => a.seq - b.seq);
	};
	return {
		kind: "typert",
		async listNodes() {
			const nodes = [];
			for (const peer of options.peers) {
				const client = requireClient(peer.nodeId);
				const native = await fetchNativeWorkspaces(client, peer.nodeId);
				nodes.push({
					nodeId: peer.nodeId,
					label: peer.nodeId,
					endpoint: peer.baseUrl,
					online: native !== void 0,
					lastSeenAt: now(),
					workspaces: native ?? workspacesOf(peer.nodeId)
				});
			}
			return nodes;
		},
		async listWorkspaces(nodeId) {
			return resolveWorkspaces(nodeId);
		},
		async createSession(nodeId, workspaceId) {
			const client = requireClient(nodeId);
			let native = nativeIds.get(nodeId)?.has(workspaceId) ?? false;
			if (!native && nativeIds.get(nodeId) === void 0) native = (await fetchNativeWorkspaces(client, nodeId))?.some((item) => item.workspaceId === workspaceId) ?? false;
			if (native) {
				const created = await client.call("session/create", { request: { workspaceId } });
				if (typeof created.sessionId !== "string" || created.sessionId === "") throw new TypertRpcError("remote-failure", `peer ${nodeId}: session/create returned no sessionId`);
				return created.sessionId;
			}
			if (workspaceId.startsWith("cwd:")) {
				const cwd = workspaceId.slice(4);
				const created = await client.call("session/create", { request: cwd === "" ? {} : { cwd } });
				if (typeof created.sessionId !== "string" || created.sessionId === "") throw new TypertRpcError("remote-failure", `peer ${nodeId}: session/create returned no sessionId`);
				return created.sessionId;
			}
			const target = options.resolveWorkspace?.(workspaceId);
			if (target === void 0) throw new TypertRpcError("unknown-workspace", `workspace "${workspaceId}" is not a native workspace on "${nodeId}" and has no remote cwd; add it to assignment.yml`);
			if (target.nodeId !== nodeId) throw new TypertRpcError("unknown-workspace", `workspace "${workspaceId}" is assigned to "${target.nodeId}", not "${nodeId}"`);
			const value = await client.call("session/create", { request: { cwd: target.cwd } });
			if (typeof value.sessionId !== "string" || value.sessionId === "") throw new TypertRpcError("remote-failure", `peer ${nodeId}: session/create returned no sessionId`);
			return value.sessionId;
		},
		async prompt(nodeId, sessionId, text) {
			await requireClient(nodeId).call("session/prompt", { request: {
				requestId: nextRequestId("mesh-prompt"),
				sessionId,
				mode: "queue",
				content: [{
					type: "text",
					text
				}]
			} });
		},
		async readSession(nodeId, sessionId, limit = 50) {
			const client = requireClient(nodeId);
			const rows = await listSessions(client);
			const row = findRow(rows, sessionId);
			if (row === void 0) throw new TypertRpcError("unknown-session", `peer ${nodeId}: session "${sessionId}" is not on this node`);
			const cursor = row.projections?.asOfSeq ?? 0;
			if (cursor === 0) return [];
			const value = await client.call("session/page", { request: {
				address: {
					kind: "session",
					sessionId
				},
				throughSeq: cursor,
				maxMessages: Math.max(1, Math.min(limit, 200))
			} });
			const messages = [];
			for (const record of value.records ?? []) {
				const event = record.event ?? record;
				const type = typeof event.type === "string" ? event.type : "";
				const seq = typeof event.seq === "number" ? event.seq : -1;
				if (seq < 0) continue;
				const data = event.data;
				const time = typeof event.time === "number" ? event.time : void 0;
				if (type === "user/message") {
					const text = partsToText(data?.content);
					if (text !== "") messages.push({
						seq,
						role: "user",
						text,
						...time === void 0 ? {} : { time }
					});
				} else if (type === "assistant/message") {
					const message = data?.message;
					const text = partsToText(message?.content);
					if (text !== "") messages.push({
						seq,
						role: "assistant",
						text,
						...time === void 0 ? {} : { time }
					});
				}
			}
			return messages.sort((a, b) => a.seq - b.seq);
		},
		async readEvents(nodeId, sessionId, request = {}) {
			const client = requireClient(nodeId);
			const rows = await listSessions(client);
			const row = findRow(rows, sessionId);
			if (row === void 0) throw new TypertRpcError("unknown-session", `peer ${nodeId}: session "${sessionId}" is not on this node`);
			const end = typeof row.projections?.asOfSeq === "number" ? row.projections.asOfSeq : 0;
			const through = typeof request.throughSeq === "number" ? Math.min(request.throughSeq, end) : end;
			if (through <= 0) return {
				events: [],
				hasMore: false,
				endSeq: end,
				running: row.running === true
			};
			const maxMessages = Math.max(1, Math.min(request.maxMessages ?? 200, 400));
			const page = {
				address: {
					kind: "session",
					sessionId
				},
				throughSeq: through,
				maxMessages
			};
			if (typeof request.beforeSeq === "number") page.beforeSeq = request.beforeSeq;
			const value = await client.call("session/page", { request: page });
			return {
				events: (value.records ?? []).map((record) => record.event ?? record).filter((event) => typeof event.seq === "number").sort((a, b) => a.seq - b.seq),
				hasMore: value.hasMore === true,
				endSeq: end,
				running: row.running === true
			};
		},
		async readAssistantLive(nodeId, sessionId, since) {
			const client = requireClient(nodeId);
			const at = Math.max(0, Math.floor(since));
			if (client.relayMode) {
				const value = await client.relayOp("assistant-live", {
					sessionId,
					since: at
				});
				return {
					revision: typeof value.revision === "number" ? value.revision : 0,
					frames: Array.isArray(value.frames) ? value.frames : []
				};
			}
			const query = "?sessionId=" + encodeURIComponent(sessionId) + "&since=" + String(at);
			const body = await client.get("/api/mesh/session/live" + query);
			if (body.ok !== true) {
				const message = typeof body.error === "string" ? body.error : "live frames unavailable";
				throw new TypertRpcError("unavailable", "peer " + nodeId + ": " + message);
			}
			return {
				revision: typeof body.revision === "number" ? body.revision : 0,
				frames: Array.isArray(body.frames) ? body.frames : []
			};
		},
		async control(nodeId, op, args) {
			const client = requireClient(nodeId);
			if (!client.relayMode) throw new TransportUnavailableError(`peer ${nodeId}: control operations require meshSecret (relay mode)`);
			try {
				return await client.relayOp(op, args);
			} catch (err) {
				noteFailure(nodeId);
				throw err;
			}
		},
		async follow(nodeId, sessionId, onEvent) {
			const client = requireClient(nodeId);
			const rows = await listSessions(client);
			const row = findRow(rows, sessionId);
			if (row === void 0) throw new TypertRpcError("unknown-session", `peer ${nodeId}: session "${sessionId}" is not on this node`);
			const baselineCursor = row.projections?.asOfSeq ?? 0;
			for (const event of await readEvents(client, sessionId, baselineCursor, -1)) onEvent(event);
			onEvent({
				type: "mesh/baseline/end",
				seq: baselineCursor
			});
			let lastSeq = baselineCursor;
			let stopped = false;
			let inflight = false;
			const tick = async () => {
				if (stopped || inflight) return;
				inflight = true;
				try {
					const nextRows = await listSessions(client);
					const cursor = findRow(nextRows, sessionId)?.projections?.asOfSeq;
					if (typeof cursor === "number" && cursor > lastSeq) for (const event of await readEvents(client, sessionId, cursor, lastSeq)) {
						lastSeq = Math.max(lastSeq, event.seq);
						onEvent(event);
					}
				} catch (err) {
					onEvent({
						type: "session/error",
						error: { message: err instanceof Error ? err.message : String(err) }
					});
				} finally {
					inflight = false;
				}
			};
			const timer = setInterval(() => {
				tick();
			}, pollMs);
			return () => {
				stopped = true;
				clearInterval(timer);
			};
		}
	};
}
// src/tools/types.ts
/** Cordis registration name; mesh_status reports the same string. */
const PLUGIN_NAME = "dsh-workspace-mesh";
const MESH_ERROR_CODE_VALUES = [
	"denied",
	"grant-expired",
	"node-offline",
	"scope-violation",
	"tier-not-granted",
	"timeout",
	"remote-failure",
	"unavailable",
	"unknown-node",
	"invalid-target"
];
/** Shared transport report for mesh_status / mesh_list_nodes. */
const TRANSPORT_REPORT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		configured: {
			type: "boolean",
			description: "Whether a MeshTransport implementation is active."
		},
		mode: {
			type: "string",
			description: "Configured transport selection (auto)."
		},
		kind: {
			type: "string",
			description: "Active transport kind (mock), empty when none."
		},
		reason: {
			type: "string",
			description: "Why no transport is active; empty when configured."
		}
	},
	required: [
		"configured",
		"mode",
		"kind",
		"reason"
	]
};
const WORKSPACE_VIEW_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		workspaceId: { type: "string" },
		name: { type: "string" },
		path: { type: "string" },
		sessions: {
			type: "integer",
			description: "Number of sessions in the workspace (metadata only)."
		},
		sessionList: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					sessionId: { type: "string" },
					title: { type: "string" },
					updatedAt: { type: "number" },
					busy: {
						type: "boolean",
						description: "True while a turn is running in that session."
					}
				},
				required: [
					"sessionId",
					"title",
					"updatedAt",
					"busy"
				]
			}
		}
	},
	required: [
		"workspaceId",
		"name",
		"path",
		"sessions",
		"sessionList"
	]
};
function transportReport(runtime) {
	if (runtime.transport !== void 0) return {
		configured: true,
		mode: runtime.config.transportMode,
		kind: runtime.transport.kind,
		reason: ""
	};
	const reason = runtime.transportError === void 0 || runtime.transportError === "" ? "no transport configured" : `no transport configured (${runtime.transportError})`;
	return {
		configured: false,
		mode: runtime.config.transportMode,
		kind: "",
		reason
	};
}
function workspaceViews(workspaces) {
	return workspaces.map((workspace) => ({
		workspaceId: workspace.workspaceId,
		name: workspace.name,
		path: workspace.path,
		sessions: workspace.sessions.length,
		sessionList: workspace.sessions.map((session) => ({
			sessionId: session.sessionId,
			title: session.title,
			updatedAt: session.updatedAt,
			busy: session.busy
		}))
	}));
}
/** Render the canonical value as JSON text; malformed values still render something readable. */
function renderJson(_args, value) {
	let text;
	try {
		text = JSON.stringify(value, null, 2);
	} catch {
		text = String(value);
	}
	return [{
		type: "text",
		text
	}];
}
function asArgsRecord(args, toolName) {
	if (args === void 0 || args === null) return {};
	if (typeof args !== "object" || Array.isArray(args)) throw new Error(`${toolName}: arguments must be an object`);
	return args;
}
function rejectUnknownArgs(record, known, toolName) {
	const allowed = new Set(known);
	for (const key of Object.keys(record)) if (!allowed.has(key)) throw new Error(`${toolName}: unknown argument "${key}"`);
}
function optionalString(record, key, toolName, options = {}) {
	const value = record[key];
	if (value === void 0) return void 0;
	if (typeof value !== "string") throw new Error(`${toolName}: "${key}" must be a string`);
	if (options.nonEmpty === true && value.trim() === "") throw new Error(`${toolName}: "${key}" must be a non-empty string`);
	return value;
}
function requiredString(record, key, toolName) {
	const value = optionalString(record, key, toolName, { nonEmpty: true });
	if (value === void 0) throw new Error(`${toolName}: "${key}" is required`);
	return value;
}
// src/tools/protocol.ts
/**
* Translation between transport failures and the mesh error vocabulary, plus the
* reply collector that turns a `follow()` event stream into one final summary.
*
* Event shapes (P2 contract, matching DSH session events):
* - `assistant/message` with `data.message.content` text blocks feeds the summary
* - `turn/end` (or `final: true` / `done: true` / `session/idle`) is terminal
* - `error` / `session/error` / `task/failed` (or an `error` payload on an
*   error-typed event) is a failure
* - `mesh/baseline/end` marks the end of a replacement baseline (SPEC §7.2)
* The mock transport scripts these shapes directly, so the P2 path never guesses.
*/
const MESH_ERROR_CODES = new Set(MESH_ERROR_CODE_VALUES);
function isMeshToolErrorCode(value) {
	return typeof value === "string" && MESH_ERROR_CODES.has(value);
}
/**
* Map an adapter-specific error code onto the tool vocabulary. Local degradation
* and target mistakes keep distinct codes instead of masquerading as remote
* failures (F-5): missing transport -> unavailable, unknown node -> unknown-node,
* unassigned workspace -> invalid-target.
*/
function mapErrorCode(rawCode) {
	if (isMeshToolErrorCode(rawCode)) return rawCode;
	switch (rawCode) {
		case "offline":
		case "node-not-found": return "node-offline";
		case "unknown-workspace":
		case "no-assignment":
		case "bad-target": return "invalid-target";
		case "unknown-session": return "invalid-target";
		case "expired":
		case "lease-expired": return "grant-expired";
		case "forbidden":
		case "unauthorized": return "denied";
		case "ETIMEDOUT":
		case "aborted": return "timeout";
		case "transport-unavailable": return "unavailable";
		default: return "remote-failure";
	}
}
function meshErrorFrom(rawCode, message, cause) {
	return cause === void 0 ? {
		code: mapErrorCode(rawCode),
		message
	} : {
		code: mapErrorCode(rawCode),
		message,
		cause
	};
}
function causeOf(err) {
	if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
	if (typeof err === "string") return void 0;
	try {
		return JSON.stringify(err);
	} catch {
		return;
	}
}
/** Normalise anything thrown by a transport or the task board, preserving cause. */
function toMeshError(err) {
	const cause = causeOf(err);
	if (typeof err === "object" && err !== null) {
		const record = err;
		const rawCode = typeof record.code === "string" ? record.code : void 0;
		const message = typeof record.message === "string" ? record.message : err instanceof Error ? err.message : String(err);
		const error = meshErrorFrom(rawCode, message === "" ? "unknown transport failure" : message, cause);
		if (rawCode === void 0) console.warn("[mesh] unexpected dispatch failure:", message, cause);
		return error;
	}
	const message = typeof err === "string" ? err : String(err);
	return meshErrorFrom(void 0, message === "" ? "unknown transport failure" : message, cause);
}
/** Build the single user message a dispatched task sends to the remote session. */
function buildDispatchPrompt(input) {
	const lines = [`[mesh task ${input.taskId}] ${input.objective}`];
	const context = input.context?.trim();
	if (context !== void 0 && context !== "") lines.push("", "Context:", context);
	if (input.acceptance !== void 0 && input.acceptance.length > 0) {
		lines.push("", "Acceptance criteria:");
		input.acceptance.forEach((criterion, index) => lines.push(`${index + 1}. ${criterion}`));
	}
	return lines.join("\n");
}
const TERMINAL_TYPES = /* @__PURE__ */ new Set([
	"turn/end",
	"session/end",
	"session/idle",
	"task/done",
	"task/complete",
	"done",
	"complete",
	"assistant/final",
	"result"
]);
const FAILURE_REASON_KINDS = /* @__PURE__ */ new Set([
	"error",
	"failed",
	"aborted",
	"interrupted",
	"timeout",
	"cancelled"
]);
/** Explicit baseline terminator a transport may deliver to a follower (SPEC §7.2). */
const BASELINE_BOUNDARY_TYPES = /* @__PURE__ */ new Set(["mesh/baseline/end", "baseline/end"]);
function eventSeq(event) {
	const record = asRecord(event);
	if (record === void 0) return void 0;
	const seq = record.seq;
	return typeof seq === "number" && Number.isFinite(seq) ? seq : void 0;
}
function asRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function eventType(record) {
	const value = record.type ?? record.event ?? record.kind;
	return typeof value === "string" ? value : void 0;
}
function contentToText(content) {
	if (typeof content === "string") return content.trim() === "" ? void 0 : content;
	if (!Array.isArray(content)) return void 0;
	const parts = [];
	for (const block of content) {
		const record = asRecord(block);
		if (record !== void 0 && record.type === "text" && typeof record.text === "string") parts.push(record.text);
	}
	const joined = parts.join("");
	return joined.trim() === "" ? void 0 : joined;
}
/** Best-effort assistant text extraction for mock and real DSH session events. */
function extractAssistantText(event) {
	const record = asRecord(event);
	if (record === void 0) return typeof event === "string" && event.trim() !== "" ? event : void 0;
	for (const key of ["text", "delta"]) {
		const value = record[key];
		if (typeof value === "string" && value.trim() !== "") return value;
	}
	const directContent = contentToText(record.content);
	if (directContent !== void 0) return directContent;
	const message = asRecord(record.message);
	if (message !== void 0) {
		const text = contentToText(message.content);
		if (text !== void 0) return text;
		if (typeof message.text === "string" && message.text.trim() !== "") return message.text;
	}
	const data = asRecord(record.data);
	if (data !== void 0) {
		for (const key of ["text", "delta"]) {
			const value = data[key];
			if (typeof value === "string" && value.trim() !== "") return value;
		}
		const nestedMessage = asRecord(data.message);
		if (nestedMessage !== void 0) {
			const text = contentToText(nestedMessage.content);
			if (text !== void 0) return text;
			if (typeof nestedMessage.text === "string" && nestedMessage.text.trim() !== "") return nestedMessage.text;
		}
		const dataContent = contentToText(data.content);
		if (dataContent !== void 0) return dataContent;
	}
}
function readFailure(event) {
	const record = asRecord(event);
	if (record === void 0) return void 0;
	const type = eventType(record);
	const errorValue = record.error;
	const errorRecord = asRecord(errorValue);
	const errorType = type !== void 0 && (type === "error" || type.endsWith("/error") || type === "task/failed" || type.endsWith("/failed"));
	const hasErrorPayload = (type === void 0 || type === "error" || type.includes("error") || type.includes("failed") || type.startsWith("session/")) && (errorRecord !== void 0 || typeof errorValue === "string");
	if (!errorType && !hasErrorPayload) return void 0;
	const directMessage = typeof record.message === "string" && record.message.trim() !== "" ? record.message : void 0;
	const payloadMessage = errorRecord !== void 0 && typeof errorRecord.message === "string" && errorRecord.message.trim() !== "" ? errorRecord.message : typeof errorValue === "string" && errorValue.trim() !== "" ? errorValue : void 0;
	return {
		message: directMessage ?? payloadMessage ?? `session reported ${type ?? "an error"}`,
		code: typeof record.code === "string" ? record.code : errorRecord !== void 0 && typeof errorRecord.code === "string" ? errorRecord.code : void 0
	};
}
function readTerminalSummary(event) {
	const record = asRecord(event);
	if (record === void 0) return void 0;
	if (typeof record.summary === "string" && record.summary.trim() !== "") return record.summary;
	const data = asRecord(record.data);
	if (data !== void 0 && typeof data.summary === "string" && data.summary.trim() !== "") return data.summary;
}
function readFailureReason(event) {
	const record = asRecord(event);
	if (record === void 0) return void 0;
	const data = asRecord(record.data);
	const reason = data === void 0 ? void 0 : asRecord(data.reason);
	if (reason === void 0) return void 0;
	const kind = reason.kind;
	if (typeof kind !== "string" || !FAILURE_REASON_KINDS.has(kind)) return void 0;
	return {
		message: typeof reason.message === "string" && reason.message.trim() !== "" ? reason.message : `turn ended with reason "${kind}"`,
		code: kind === "timeout" ? "timeout" : void 0
	};
}
/** Whether an event closes the turn whose reply the dispatcher is waiting for. */
function isTerminalEvent(event) {
	const record = asRecord(event);
	if (record === void 0) return false;
	if (record.final === true || record.done === true || record.complete === true) return true;
	const type = eventType(record);
	return type !== void 0 && TERMINAL_TYPES.has(type);
}
/**
* Collects one turn's events. `start()` clears anything replayed by the initial
* `follow()` baseline (SPEC §7.2), so resume cannot mistake old history for the
* reply to this prompt.
*/
var ReplyCollector = class {
	eventCount = 0;
	texts = [];
	terminalSummary;
	started = false;
	settled;
	resolveWait;
	timer;
	abortSignal;
	abortListener;
	/** Events before the baseline boundary are replacement history, never this turn. */
	baselineOpen = false;
	baselineLastSeq = Number.NEGATIVE_INFINITY;
	minimumSeq;
	/**
	* Start collecting. This MUST be called before follow(): the follow call itself
	* may deliver the replacement baseline (sync) or schedule it (async), and none
	* of it may count toward this turn's summary. Call endBaseline() when the
	* transport signals the boundary (onBaselineDone or a boundary event).
	*/
	start() {
		this.started = true;
		this.baselineOpen = true;
		this.baselineLastSeq = Number.NEGATIVE_INFINITY;
		this.minimumSeq = void 0;
		this.eventCount = 0;
		this.texts = [];
		this.terminalSummary = void 0;
		this.settled = void 0;
	}
	/** Close the baseline window; anything at or below its last seq is discarded. */
	endBaseline() {
		if (!this.started) return;
		this.baselineOpen = false;
		this.minimumSeq = Number.isFinite(this.baselineLastSeq) ? this.baselineLastSeq + 1 : void 0;
		this.eventCount = 0;
		this.texts = [];
		this.terminalSummary = void 0;
	}
	push(event) {
		if (!this.started || this.settled !== void 0) return;
		const type = asRecord(event) === void 0 ? void 0 : eventType(asRecord(event));
		if (type !== void 0 && BASELINE_BOUNDARY_TYPES.has(type)) {
			if (this.baselineOpen) this.endBaseline();
			return;
		}
		if (this.baselineOpen) {
			const seq = eventSeq(event);
			if (seq !== void 0) this.baselineLastSeq = Math.max(this.baselineLastSeq, seq);
			return;
		}
		const seq = eventSeq(event);
		if (this.minimumSeq !== void 0 && seq !== void 0 && seq < this.minimumSeq) return;
		this.eventCount += 1;
		const failure = readFailure(event) ?? readFailureReason(event);
		if (failure !== void 0) {
			this.complete({
				kind: "failure",
				failure,
				eventCount: this.eventCount
			});
			return;
		}
		const text = extractAssistantText(event);
		if (text !== void 0) this.texts.push(text);
		if (isTerminalEvent(event)) {
			this.terminalSummary = readTerminalSummary(event);
			this.complete({
				kind: "final",
				summary: this.summary(),
				eventCount: this.eventCount
			});
		}
	}
	/** The settled outcome, if any; used by stream mode without waiting. */
	outcome() {
		return this.settled;
	}
	get baselineDone() {
		return this.started && !this.baselineOpen;
	}
	summary() {
		if (this.terminalSummary !== void 0) return this.terminalSummary;
		return this.texts.at(-1) ?? "";
	}
	latestText() {
		return this.texts.at(-1) ?? "";
	}
	snapshot() {
		return {
			eventCount: this.eventCount,
			latestText: this.latestText(),
			terminal: this.settled !== void 0
		};
	}
	wait(timeoutMs, signal) {
		if (this.settled !== void 0) return Promise.resolve(this.settled);
		return new Promise((resolve) => {
			this.resolveWait = resolve;
			this.timer = setTimeout(() => {
				this.complete({
					kind: "timeout",
					eventCount: this.eventCount,
					latestText: this.latestText()
				});
			}, timeoutMs);
			if (signal !== void 0) {
				if (signal.aborted) {
					this.complete({
						kind: "aborted",
						eventCount: this.eventCount
					});
					return;
				}
				this.abortSignal = signal;
				this.abortListener = () => this.complete({
					kind: "aborted",
					eventCount: this.eventCount
				});
				signal.addEventListener("abort", this.abortListener, { once: true });
			}
		});
	}
	dispose() {
		this.started = false;
		this.baselineOpen = false;
		this.clearWaitResources();
		this.resolveWait = void 0;
	}
	complete(outcome) {
		if (this.settled !== void 0) return;
		this.settled = outcome;
		const resolve = this.resolveWait;
		this.resolveWait = void 0;
		this.clearWaitResources();
		resolve?.(outcome);
	}
	clearWaitResources() {
		if (this.timer !== void 0) {
			clearTimeout(this.timer);
			this.timer = void 0;
		}
		if (this.abortSignal !== void 0 && this.abortListener !== void 0) {
			this.abortSignal.removeEventListener("abort", this.abortListener);
			this.abortSignal = void 0;
			this.abortListener = void 0;
		}
	}
};
// src/roster/index.ts
function assignmentIndex(runtime) {
	const assigned = /* @__PURE__ */ new Map();
	for (const route of runtime.assignment?.assignments ?? []) {
		const list = assigned.get(route.nodeId);
		if (list === void 0) assigned.set(route.nodeId, [route.workspaceId]);
		else list.push(route.workspaceId);
	}
	return assigned;
}
function seedFromAssignment(runtime, assigned) {
	const peers = /* @__PURE__ */ new Map();
	for (const node of runtime.assignment?.nodes ?? []) peers.set(node.nodeId, {
		nodeId: node.nodeId,
		label: node.label ?? "",
		endpoint: node.endpoint ?? "",
		status: "unknown",
		source: "assignment",
		workspaces: [],
		assignedWorkspaceIds: assigned.get(node.nodeId) ?? []
	});
	for (const route of runtime.assignment?.assignments ?? []) {
		if (peers.has(route.nodeId)) continue;
		peers.set(route.nodeId, {
			nodeId: route.nodeId,
			label: "",
			endpoint: "",
			status: "unknown",
			source: "assignment",
			workspaces: [],
			assignedWorkspaceIds: assigned.get(route.nodeId) ?? []
		});
	}
	return peers;
}
function mergeDescriptor(peer, descriptor) {
	if (peer.label === "") peer.label = descriptor.label;
	if (peer.endpoint === "") peer.endpoint = descriptor.endpoint;
	peer.status = descriptor.online ? "online" : "offline";
	peer.source = "both";
	peer.workspaces = workspaceViews(descriptor.workspaces);
	peer.lastSeenAt = descriptor.lastSeenAt;
}
/** Wire shape consumed by the model tool and the settings page. */
function wirePeer(peer) {
	const wire = {
		nodeId: peer.nodeId,
		label: peer.label === "" ? peer.nodeId : peer.label,
		endpoint: peer.endpoint,
		online: peer.status === "online",
		status: peer.status,
		source: peer.source,
		workspaces: peer.workspaces,
		assignedWorkspaceIds: peer.assignedWorkspaceIds
	};
	if (peer.lastSeenAt !== void 0) wire.lastSeenAt = peer.lastSeenAt;
	return wire;
}
/** Merge assignment.yml with transport receipts. Never throws: a failing transport becomes a note. */
async function deriveRoster(runtime) {
	const notes = [];
	const assigned = assignmentIndex(runtime);
	const peers = seedFromAssignment(runtime, assigned);
	if (runtime.transport === void 0) {
		notes.push("no transport configured; node status is unknown");
		return {
			peers: [...peers.values()],
			notes
		};
	}
	try {
		for (const descriptor of await runtime.transport.listNodes()) {
			const existing = peers.get(descriptor.nodeId);
			if (existing === void 0) peers.set(descriptor.nodeId, {
				nodeId: descriptor.nodeId,
				label: descriptor.label,
				endpoint: descriptor.endpoint,
				status: descriptor.online ? "online" : "offline",
				source: "transport",
				lastSeenAt: descriptor.lastSeenAt,
				workspaces: workspaceViews(descriptor.workspaces),
				assignedWorkspaceIds: assigned.get(descriptor.nodeId) ?? []
			});
			else mergeDescriptor(existing, descriptor);
		}
	} catch (err) {
		notes.push(`transport listNodes failed: ${toMeshError(err).message}; node status is unknown where no receipt exists`);
	}
	return {
		peers: [...peers.values()],
		notes
	};
}
// src/api/state.ts
/**
* Snapshot served to the browser settings page. Deliberately metadata only:
* ids, states, timestamps and the lifecycle/board counters the host already
* keeps. No task objectives beyond a short preview, no session log, no file
* contents.
*/
const MESH_STATE_VERSION = 1;
/** Newest tasks kept in the payload; the board itself is unbounded. */
const MAX_TASK_ROWS = 25;
const TASK_STATES$1 = [
	"queued",
	"dispatched",
	"running",
	"done",
	"failed",
	"expired"
];
function emptyCounts() {
	return {
		total: 0,
		queued: 0,
		dispatched: 0,
		running: 0,
		done: 0,
		failed: 0,
		expired: 0
	};
}
function countTasks$1(tasks) {
	const counts = emptyCounts();
	for (const task of tasks) {
		counts.total += 1;
		if (TASK_STATES$1.includes(task.state)) counts[task.state] += 1;
	}
	return counts;
}
function taskView(task) {
	const objective = task.objective.length > 160 ? `${task.objective.slice(0, 160)}…` : task.objective;
	const view = {
		taskId: task.taskId,
		state: task.state,
		nodeId: task.target.nodeId,
		workspaceId: task.target.workspaceId,
		objective,
		createdAt: task.createdAt,
		updatedAt: task.updatedAt,
		leaseOwner: task.lease.owner,
		leaseExpiresAt: task.lease.expiresAt
	};
	if (task.error !== void 0 && task.error !== "") view.error = task.error;
	return view;
}
/** Newest tasks first, capped at MAX_TASK_ROWS. */
function recentTasks(tasks, limit = 25) {
	return [...tasks].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, limit);
}
/**
* Build the settings-page payload. Pure read: it never mutates the board,
* never dispatches, and degrades to notes when the transport is unavailable.
*/
async function buildMeshState(runtime, now = Date.now, extras = {}) {
	const roster = await deriveRoster(runtime);
	const tasks = runtime.board.list();
	const lifecycle = runtime.lifecycle.status();
	return {
		ok: true,
		version: 1,
		plugin: PLUGIN_NAME,
		generatedAt: now(),
		transport: transportReport(runtime),
		assignment: {
			configured: runtime.assignment !== void 0,
			file: runtime.assignment?.file ?? "",
			nodes: runtime.assignment?.nodes.length ?? 0,
			assignments: runtime.assignment?.assignments.length ?? 0
		},
		config: {
			transportMode: runtime.config.transportMode,
			assignmentFile: extras.assignmentFile ?? "",
			leaseMs: runtime.config.leaseMs,
			dispatchTimeoutMs: runtime.config.dispatchTimeoutMs,
			leaseOwner: runtime.config.leaseOwner
		},
		lifecycle: {
			state: lifecycle.state,
			supervisor: lifecycle.supervisor,
			pid: lifecycle.pid,
			startedAt: lifecycle.startedAt
		},
		counts: countTasks$1(tasks),
		peers: roster.peers.map(wirePeer),
		tasks: recentTasks(tasks).map(taskView),
		notes: roster.notes,
		configFile: extras.configFile ?? ""
	};
}
// src/api/mount.ts
function asRouteContext(ctx) {
	if (ctx === null || typeof ctx !== "object") return void 0;
	if (typeof ctx.get !== "function") return void 0;
	return ctx;
}
function connectionOf(ctx) {
	const service = ctx.get("connection");
	if (service === null || typeof service !== "object") return void 0;
	return service;
}
/** JSON reply with the cache defeated: the page polls it. */
function jsonResponse(value, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store"
		}
	});
}
/**
* Run `mount` once Connection is available (immediately when it already is).
* @returns whether the route was mounted synchronously.
*/
function withConnection(ctx, mount) {
	const routeCtx = asRouteContext(ctx);
	if (routeCtx === void 0) return false;
	const inject = routeCtx.inject;
	if (typeof inject !== "function") return mount(routeCtx);
	let mounted = false;
	inject.call(routeCtx, ["connection"], (inner) => {
		const resolved = asRouteContext(inner);
		if (resolved !== void 0) mounted = mount(resolved);
	});
	return mounted;
}
/** Register one exact route on a Connection-bearing context. */
function mountExactRoute(ctx, route) {
	const registrar = connectionOf(ctx)?.fetch;
	if (registrar === void 0 || typeof registrar.register !== "function") {
		console.info("[mesh] settings page: no connection.fetch service; " + route.path + " is not served");
		return false;
	}
	registrar.register({
		path: route.path,
		methods: route.methods,
		requestBody: route.requestBody ?? "buffered",
		fetch: route.fetch
	});
	console.info("[mesh] settings page route mounted at " + route.path);
	return true;
}
// src/api/index.ts
/** Read-only snapshot endpoint polled by the settings page. */
const MESH_STATE_PATH = "/api/mesh/state";
function resolveExtras(source) {
	return typeof source === "function" ? source() : source;
}
/**
* Register the state route on a context that already has Connection.
* @returns whether the route was mounted.
*/
function mountMeshStateRoute(ctx, runtime, extras = {}) {
	return mountExactRoute(ctx, {
		path: MESH_STATE_PATH,
		methods: ["GET"],
		fetch: async () => {
			try {
				return jsonResponse(await buildMeshState(runtime, Date.now, resolveExtras(extras)));
			} catch (err) {
				return jsonResponse({
					ok: false,
					error: err instanceof Error ? err.message : String(err)
				}, 500);
			}
		}
	});
}
/** Serve the settings-page snapshot at /api/mesh/state. */
function registerMeshStateRoute(ctx, runtime, extras = {}) {
	withConnection(ctx, (inner) => mountMeshStateRoute(inner, runtime, extras));
}
// src/config/store.ts
const MESH_CONFIG_FILE_NAME = "mesh-config.json";
const TRANSPORTS = ["auto"];
/** Override file path: explicit, else $DSH_HOME, else ~/.dsh. */
function meshConfigPath(explicit) {
	if (explicit !== void 0 && explicit !== "") return explicit;
	const home = process.env.DSH_HOME !== void 0 && process.env.DSH_HOME !== "" ? process.env.DSH_HOME : join(homedir(), ".dsh");
	return join(home, MESH_CONFIG_FILE_NAME);
}
function isString(value) {
	return typeof value === "string";
}
function isNonNegativeInteger(value) {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
/** Validate one untrusted override object; unknown keys and bad types are problems. */
function sanitizeOverride(raw) {
	const problems = [];
	const value = {};
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {
		value,
		problems: ["config body must be a JSON object"]
	};
	const record = raw;
	for (const key of Object.keys(record)) {
		const entry = record[key];
		switch (key) {
			case "transport":
				if (isString(entry) && TRANSPORTS.includes(entry)) value.transport = entry;
				else problems.push("transport must be auto");
				break;
			case "peers": {
				if (!Array.isArray(entry)) {
					problems.push("peers must be an array");
					break;
				}
				const peers = [];
				let bad = false;
				for (let index = 0; index < entry.length; index += 1) {
					const item = entry[index];
					const record = typeof item === "object" && item !== null && !Array.isArray(item) ? item : void 0;
					const nodeId = record?.nodeId;
					const baseUrl = record?.baseUrl;
					const token = record?.token;
					if (typeof nodeId !== "string" || nodeId.trim() === "") {
						problems.push(`peers[${index}].nodeId must be a non-empty string`);
						bad = true;
						break;
					}
					if (typeof baseUrl !== "string" || !/^https?:\/\//u.test(baseUrl.trim())) {
						problems.push(`peers[${index}].baseUrl must start with http:// or https://`);
						bad = true;
						break;
					}
					if (typeof token !== "string" || token.trim() === "") {
						problems.push(`peers[${index}].token must be a non-empty string`);
						bad = true;
						break;
					}
					peers.push({
						nodeId: nodeId.trim(),
						baseUrl: baseUrl.trim(),
						token: token.trim()
					});
				}
				if (!bad) value.peers = peers;
				break;
			}
			case "meshSecret":
				if (!isString(entry)) problems.push("meshSecret must be a string");
				else value.meshSecret = entry.trim();
				break;
			case "assignmentFile":
				if (!isString(entry)) problems.push("assignmentFile must be a string");
				else value.assignmentFile = entry.trim();
				break;
			case "leaseOwner":
				if (!isString(entry) || entry.trim() === "") problems.push("leaseOwner must be a non-empty string");
				else value.leaseOwner = entry.trim();
				break;
			case "leaseMs":
				if (!isNonNegativeInteger(entry)) problems.push("leaseMs must be a non-negative integer");
				else value.leaseMs = entry;
				break;
			case "dispatchTimeoutMs":
				if (!isNonNegativeInteger(entry)) problems.push("dispatchTimeoutMs must be a non-negative integer");
				else value.dispatchTimeoutMs = entry;
				break;
			default: problems.push("unknown config key \"" + key + "\"");
		}
	}
	return {
		value,
		problems
	};
}
/** Read the override file; every failure mode degrades to "no overrides". */
function readConfigOverride(file = meshConfigPath()) {
	let text;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return {};
	}
	try {
		const sanitized = sanitizeOverride(JSON.parse(text));
		if (sanitized.problems.length > 0) {
			console.warn("[mesh] ignoring invalid overrides in " + file + ": " + sanitized.problems.join("; "));
			return {};
		}
		return sanitized.value;
	} catch (err) {
		console.warn("[mesh] ignoring unreadable overrides in " + file + ": " + (err instanceof Error ? err.message : String(err)));
		return {};
	}
}
/** Merge a validated patch into the override file (atomic replace). */
function writeConfigOverride(patch, file = meshConfigPath()) {
	const merged = {
		...readConfigOverride(file),
		...patch
	};
	mkdirSync(dirname(file), { recursive: true });
	const temporary = file + ".tmp";
	writeFileSync(temporary, JSON.stringify(merged, null, 2) + "\n", "utf8");
	renameSync(temporary, file);
	return merged;
}
// src/api/config.ts
/**
* Browser-writable configuration, served next to the read-only snapshot.
*
* Writes land in the plugin's own override file ($DSH_HOME/mesh-config.json)
* because the native settings document does not project profile-patch mounted
* entries. Lease fields and the assignment table apply to this process
* immediately; transport selection and the peer URL need a restart because the
* transport object is built during plugin apply.
*/
const MESH_CONFIG_PATH = "/api/mesh/config";
/** Fields that take effect without restarting the host process. */
const HOT_CONFIG_KEYS = [
	"leaseMs",
	"dispatchTimeoutMs",
	"leaseOwner",
	"assignmentFile"
];
/** Fields persisted now but applied by the next plugin apply (container restart). */
const RESTART_CONFIG_KEYS = ["transport", "peers"];
/**
* Validate and persist one config patch, then apply the hot subset.
* @returns the HTTP reply: 400 for a rejected patch, 200 with the fresh state otherwise.
*/
async function handleConfigSave(request, control) {
	let body;
	try {
		body = await request.json();
	} catch {
		return jsonResponse({
			ok: false,
			error: "body must be JSON"
		}, 400);
	}
	const sanitized = sanitizeOverride(body);
	if (sanitized.problems.length > 0) return jsonResponse({
		ok: false,
		error: sanitized.problems.join("; ")
	}, 400);
	const patch = sanitized.value;
	if (Object.keys(patch).length === 0) return jsonResponse({
		ok: false,
		error: "no config keys supplied"
	}, 400);
	let nextAssignment;
	const assignmentFile = patch.assignmentFile;
	if (assignmentFile !== void 0) {
		if (assignmentFile === "") nextAssignment = void 0;
		else try {
			nextAssignment = loadAssignmentTable(assignmentFile);
		} catch (err) {
			return jsonResponse({
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, 400);
		}
	}
	writeConfigOverride(patch, control.file);
	const applied = [];
	const pendingRestart = [];
	const runtimeConfig = control.runtime.config;
	if (patch.leaseMs !== void 0) {
		runtimeConfig.leaseMs = patch.leaseMs;
		applied.push("leaseMs");
	}
	if (patch.dispatchTimeoutMs !== void 0) {
		runtimeConfig.dispatchTimeoutMs = patch.dispatchTimeoutMs;
		applied.push("dispatchTimeoutMs");
	}
	if (patch.leaseOwner !== void 0) {
		runtimeConfig.leaseOwner = patch.leaseOwner;
		applied.push("leaseOwner");
	}
	if (assignmentFile !== void 0) {
		control.runtime.assignment = nextAssignment;
		applied.push("assignmentFile");
	}
	if (patch.peers !== void 0) pendingRestart.push("peers");
	if (patch.transport !== void 0) {
		runtimeConfig.transportMode = patch.transport;
		pendingRestart.push("transport");
	}
	return jsonResponse({
		ok: true,
		applied,
		pendingRestart,
		state: await buildMeshState(control.runtime, Date.now, control.extras())
	});
}
/** Register POST /api/mesh/config on a Connection-bearing context. */
function mountMeshConfigRoute(ctx, control) {
	return mountExactRoute(ctx, {
		path: MESH_CONFIG_PATH,
		methods: ["POST"],
		fetch: async (request) => {
			try {
				return await handleConfigSave(request, control);
			} catch (err) {
				return jsonResponse({
					ok: false,
					error: err instanceof Error ? err.message : String(err)
				}, 500);
			}
		}
	});
}
/** Serve POST /api/mesh/config. */
function registerMeshConfigRoute(ctx, control) {
	withConnection(ctx, (inner) => mountMeshConfigRoute(inner, control));
}
// src/tools/task-id.ts
/** Crockford base32 alphabet used by ULID (no I, L, O, U). */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/**
* Generate a ULID-shaped task id (SPEC §5.3: "taskId: ULID") without a
* dependency: 10 base32 characters of millisecond time followed by 16
* characters (80 bits) of randomness, 26 characters total.
*/
function createTaskId(now = Date.now(), random = randomBytes) {
	let time = Math.floor(now);
	if (!Number.isFinite(time) || time < 0) throw new RangeError(`task id timestamp must be a non-negative finite number, got ${now}`);
	const timePart = new Array(10);
	for (let index = 9; index >= 0; index -= 1) {
		timePart[index] = CROCKFORD[time % 32];
		time = Math.floor(time / 32);
	}
	const bytes = random(10);
	if (bytes.length < 10) throw new Error("createTaskId needs at least 10 random bytes");
	let randomPart = "";
	let bits = 0;
	let value = 0;
	for (const byte of bytes) {
		value = value << 8 | byte;
		bits += 8;
		while (bits >= 5) {
			randomPart += CROCKFORD[value >>> bits - 5 & 31];
			bits -= 5;
		}
	}
	return timePart.join("") + randomPart.slice(0, 16);
}
// src/tools/dispatch.ts
const DISPATCH_ARG_KEYS$1 = [
	"workspaceId",
	"objective",
	"nodeId",
	"context",
	"acceptance",
	"sessionMode",
	"sessionId",
	"maxDurationMs",
	"replyMode"
];
const DISPATCH_OUTPUT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		ok: { type: "boolean" },
		taskId: {
			type: "string",
			description: "Task board id (ULID-shaped)."
		},
		state: {
			type: "string",
			enum: [
				"done",
				"failed",
				"expired",
				"running"
			],
			description: "done = final reply collected; running = stream mode returned early."
		},
		target: {
			type: "object",
			additionalProperties: false,
			properties: {
				nodeId: { type: "string" },
				workspaceId: { type: "string" }
			},
			required: ["nodeId", "workspaceId"]
		},
		result: {
			type: "object",
			additionalProperties: false,
			properties: {
				summary: {
					type: "string",
					description: "Final assistant text (or an explicit no-text marker)."
				},
				sessionId: {
					type: "string",
					description: "Remote session the task ran in."
				},
				artifacts: {
					type: "array",
					items: { type: "string" }
				},
				pending: {
					type: "boolean",
					description: "stream mode only: true means the prompt was delivered but no final reply is ready."
				}
			},
			required: ["summary"]
		},
		error: {
			type: "object",
			additionalProperties: false,
			properties: {
				code: {
					type: "string",
					enum: [...MESH_ERROR_CODE_VALUES]
				},
				message: { type: "string" },
				cause: {
					type: "string",
					description: "Original error name/message/stack for diagnosis."
				}
			},
			required: ["code", "message"]
		}
	},
	required: ["ok", "state"]
};
function failure(code, message, options = {}) {
	const output = {
		ok: false,
		state: options.state ?? "failed",
		error: options.cause === void 0 ? {
			code,
			message
		} : {
			code,
			message,
			cause: options.cause
		}
	};
	if (options.taskId !== void 0) output.taskId = options.taskId;
	if (options.target !== void 0) output.target = options.target;
	return output;
}
function parseDispatchArgs(rawArgs, runtime) {
	const record = asArgsRecord(rawArgs, "mesh_dispatch");
	rejectUnknownArgs(record, DISPATCH_ARG_KEYS$1, "mesh_dispatch");
	const workspaceId = requiredString(record, "workspaceId", "mesh_dispatch");
	const objective = requiredString(record, "objective", "mesh_dispatch");
	const nodeId = optionalString(record, "nodeId", "mesh_dispatch", { nonEmpty: true });
	const context = optionalString(record, "context", "mesh_dispatch");
	const sessionId = optionalString(record, "sessionId", "mesh_dispatch", { nonEmpty: true });
	const sessionModeRaw = record.sessionMode;
	let sessionMode = "new";
	if (sessionModeRaw !== void 0) {
		if (sessionModeRaw !== "new" && sessionModeRaw !== "resume") throw new Error("mesh_dispatch: \"sessionMode\" must be \"new\" or \"resume\"");
		sessionMode = sessionModeRaw;
	}
	if (sessionMode === "resume" && sessionId === void 0) throw new Error("mesh_dispatch: sessionMode \"resume\" requires \"sessionId\"");
	const replyModeRaw = record.replyMode;
	let replyMode = "final";
	if (replyModeRaw !== void 0) {
		if (replyModeRaw !== "final" && replyModeRaw !== "stream") throw new Error("mesh_dispatch: \"replyMode\" must be \"final\" or \"stream\"");
		replyMode = replyModeRaw;
	}
	const acceptanceRaw = record.acceptance;
	let acceptance;
	if (acceptanceRaw !== void 0) {
		if (!Array.isArray(acceptanceRaw)) throw new Error("mesh_dispatch: \"acceptance\" must be an array of strings");
		acceptance = acceptanceRaw.map((item, index) => {
			if (typeof item !== "string" || item.trim() === "") throw new Error(`mesh_dispatch: "acceptance[${index}]" must be a non-empty string`);
			return item;
		});
	}
	const maxDurationRaw = record.maxDurationMs;
	const configMax = runtime.config.dispatchTimeoutMs;
	if (!Number.isFinite(configMax) || configMax <= 0) throw new Error("mesh_dispatch: dispatchTimeoutMs must be a positive finite number");
	let maxDurationMs = configMax;
	if (maxDurationRaw !== void 0) {
		if (typeof maxDurationRaw !== "number" || !Number.isFinite(maxDurationRaw) || maxDurationRaw <= 0) throw new Error("mesh_dispatch: \"maxDurationMs\" must be a positive finite number");
		if (maxDurationRaw > configMax) throw new Error(`mesh_dispatch: "maxDurationMs" must not exceed dispatchTimeoutMs (${configMax}ms); raise dispatchTimeoutMs to wait longer`);
		maxDurationMs = maxDurationRaw;
	}
	return {
		workspaceId,
		objective,
		...nodeId === void 0 ? {} : { nodeId },
		...context === void 0 ? {} : { context },
		...acceptance === void 0 ? {} : { acceptance },
		sessionMode,
		...sessionId === void 0 ? {} : { sessionId },
		maxDurationMs,
		replyMode
	};
}
function resolveTarget(args, runtime) {
	if (args.nodeId !== void 0) return {
		nodeId: args.nodeId,
		workspaceId: args.workspaceId
	};
	const route = findAssignmentRoute(runtime.assignment, args.workspaceId);
	if (route !== void 0) return {
		nodeId: route.nodeId,
		workspaceId: args.workspaceId
	};
	return failure("invalid-target", `workspace "${args.workspaceId}" has no node assignment; pass nodeId explicitly or add it to assignment.yml`);
}
function isDispatchTarget(value) {
	return "nodeId" in value;
}
function buildTask(taskId, target, args, createdAt) {
	const policy = {
		sessionMode: args.sessionMode,
		maxDurationMs: args.maxDurationMs,
		replyMode: args.replyMode,
		...args.sessionMode === "resume" && args.sessionId !== void 0 ? { sessionId: args.sessionId } : {}
	};
	return {
		taskId,
		target: { ...target },
		objective: args.objective,
		...args.context === void 0 ? {} : { context: args.context },
		...args.acceptance === void 0 ? {} : { acceptance: [...args.acceptance] },
		policy,
		lease: {
			owner: "",
			fencingToken: 0,
			expiresAt: 0
		},
		state: "queued",
		createdAt,
		updatedAt: createdAt
	};
}
/**
* mesh_dispatch — the P2 acceptance path (SPEC §12):
* Task board create -> claim lease -> createSession -> follow -> prompt ->
* collect the final reply -> release the lease and record TaskResult.
* Synthetic failures are returned as data with the MeshErrorCode vocabulary
* (plus unavailable/unknown-node/invalid-target); only malformed tool arguments
* throw (the host turns that into a normal isError tool result).
*
* Deviation from SPEC §18 (explicit): this tool blocks and returns
* { taskId, state, target, result|error } instead of { taskId }. The async
* "taskId + mesh_task_wait" model needs a durable task store; it is deferred to
* a later increment.
*
* Duration invariants: per-call maxDurationMs is capped at config
* dispatchTimeoutMs (the host tool timeout is fixed at dispatchTimeoutMs+30s,
* F-8), and the runtime must keep leaseMs > dispatchTimeoutMs so the lease
* always outlives the wait; a fenced-out finalize reports grant-expired.
*/
function createMeshDispatchTool(runtime) {
	return {
		name: "mesh_dispatch",
		description: "把任务投递到工作区所在节点并阻塞等待最终回复：写入任务板、取得租约、createSession → follow → prompt，收到 turn/end（或 final:true / session/idle）后返回 TaskResult（summary + sessionId）。nodeId 省略时查 assignment.yml。失败以 MeshErrorCode/扩展码（unavailable、unknown-node、invalid-target）返回；没有配置传输时返回 \"no transport configured\"。注意：与 SPEC §18 的异步 {taskId}+mesh_task_wait 不同（持久化任务板属后续增量），本工具直接返回结果。",
		parameters: {
			type: "object",
			properties: {
				workspaceId: {
					type: "string",
					description: "目标工作区 id（assignment.yml 的 workspaceId）。"
				},
				nodeId: {
					type: "string",
					description: "可选。省略时按 assignment.yml 解析；显式指定优先。"
				},
				objective: {
					type: "string",
					description: "交给远端会话的任务目标（必填）。"
				},
				context: {
					type: "string",
					description: "可选上下文，随 prompt 一起发送。"
				},
				acceptance: {
					type: "array",
					items: { type: "string" },
					description: "可选验收标准，作为编号列表附在 prompt 后。"
				},
				sessionMode: {
					type: "string",
					enum: ["new", "resume"],
					description: "new（默认）创建会话；resume 复用 sessionId。"
				},
				sessionId: {
					type: "string",
					description: "sessionMode=resume 时必填。"
				},
				maxDurationMs: {
					type: "number",
					description: "等待最终回复的上限（毫秒）；默认取插件配置 dispatchTimeoutMs，且不得超过它（宿主超时按 dispatchTimeoutMs+30s 固定截断，想等更久请调大配置）。"
				},
				replyMode: {
					type: "string",
					enum: ["final", "stream"],
					description: "final（默认）等待最终回复；stream 在 prompt 后立即返回已收到的文本。"
				}
			},
			required: ["workspaceId", "objective"],
			additionalProperties: false
		},
		output: {
			schema: DISPATCH_OUTPUT_SCHEMA,
			render: renderJson
		},
		timeoutMs: Math.max(runtime.config.dispatchTimeoutMs + 3e4, 6e4),
		async execute(rawArgs, exec) {
			const args = parseDispatchArgs(rawArgs, runtime);
			if (runtime.transport === void 0) return failure("unavailable", "no transport configured");
			const transport = runtime.transport;
			const resolved = resolveTarget(args, runtime);
			if (!isDispatchTarget(resolved)) return resolved;
			const target = resolved;
			const owner = runtime.config.leaseOwner;
			if (owner === "") return failure("denied", "leaseOwner must be a non-empty string", { target });
			const leaseMs = runtime.config.leaseMs;
			if (!Number.isFinite(leaseMs) || leaseMs <= 0) return failure("denied", `leaseMs must be a positive finite number, got ${leaseMs}`, { target });
			if (leaseMs <= runtime.config.dispatchTimeoutMs) return failure("denied", `leaseMs (${leaseMs}) must be greater than dispatchTimeoutMs (${runtime.config.dispatchTimeoutMs}) so the lease outlives the wait`, { target });
			const now = runtime.now ?? Date.now;
			const nextTaskId = runtime.newTaskId ?? (() => createTaskId(now()));
			let taskId;
			for (let attempt = 0; attempt < 3 && taskId === void 0; attempt += 1) {
				const candidate = nextTaskId();
				if (typeof candidate !== "string" || candidate === "") throw new Error("mesh_dispatch: newTaskId must return a non-empty string");
				if (runtime.board.get(candidate) !== void 0) continue;
				if (runtime.board.create(buildTask(candidate, target, args, now()))) taskId = candidate;
			}
			if (taskId === void 0) return failure("remote-failure", "could not allocate a unique task id after 3 attempts", { target });
			const id = taskId;
			let ownsLease = false;
			let settled = false;
			let collector;
			let unsubscribe;
			let fence = {
				owner,
				fencingToken: 0
			};
			const boardFailure = () => {
				const current = runtime.board.get(id);
				if (current === void 0) return failure("unavailable", `task board rejected the lease release or state update for task "${id}"`, {
					taskId: id,
					target
				});
				return failure("grant-expired", current.lease.owner !== fence.owner || current.lease.fencingToken !== fence.fencingToken ? `lease for task "${id}" was taken over by another owner before the result could be recorded` : `lease for task "${id}" expired before the result could be recorded`, {
					taskId: id,
					target
				});
			};
			const finalize = (state, patch) => {
				if (!ownsLease) return false;
				if (!runtime.board.update(id, {
					state,
					...patch
				}, fence)) return false;
				if (!runtime.board.release(id, owner)) return false;
				ownsLease = false;
				settled = true;
				return true;
			};
			try {
				let claimed;
				try {
					claimed = runtime.board.claim(id, owner, leaseMs);
				} catch (err) {
					if (err instanceof RangeError) return failure("denied", `lease rejected: ${err.message}`, {
						taskId: id,
						target
					});
					throw err;
				}
				if (!claimed) return failure("denied", `task "${id}" already has a live lease held by another owner`, {
					taskId: id,
					target
				});
				ownsLease = true;
				fence = {
					owner,
					fencingToken: runtime.board.get(id)?.lease.fencingToken ?? 0
				};
				if (!runtime.board.update(id, { state: "dispatched" }, fence)) return boardFailure();
				let sessionId;
				if (args.sessionMode === "resume") {
					if (args.sessionId === void 0) throw new Error("mesh_dispatch: sessionMode \"resume\" requires \"sessionId\"");
					sessionId = args.sessionId;
				} else sessionId = await transport.createSession(target.nodeId, target.workspaceId);
				const sessionKey = `${target.nodeId}\u0000${sessionId}`;
				if (!runtime.board.bindSession(id, sessionKey)) {
					const message = `session "${sessionId}" on node "${target.nodeId}" already has an active task`;
					if (!finalize("failed", { error: message })) return boardFailure();
					return failure("denied", message, {
						taskId: id,
						target
					});
				}
				if (!runtime.board.update(id, { state: "running" }, fence)) return boardFailure();
				collector = new ReplyCollector();
				collector.start();
				let baselineEnded = false;
				const follower = transport;
				unsubscribe = await follower.follow(target.nodeId, sessionId, (event) => {
					collector?.push(event);
				}, { onBaselineDone: () => {
					baselineEnded = true;
					collector?.endBaseline();
				} });
				if (!baselineEnded && follower.supportsBaselineSignal !== true) collector.endBaseline();
				await transport.prompt(target.nodeId, sessionId, buildDispatchPrompt({
					taskId: id,
					objective: args.objective,
					...args.context === void 0 ? {} : { context: args.context },
					...args.acceptance === void 0 ? {} : { acceptance: args.acceptance }
				}));
				if (args.replyMode === "stream") {
					const settled = collector.outcome();
					if (settled?.kind === "final") {
						const result = {
							summary: settled.summary.trim() === "" ? "(no assistant text received)" : settled.summary,
							sessionId
						};
						if (!finalize("done", { result })) return boardFailure();
						return {
							ok: true,
							taskId: id,
							state: "done",
							target,
							result
						};
					}
					if (settled?.kind === "failure") {
						const error = meshErrorFrom(settled.failure.code, settled.failure.message);
						if (!finalize("failed", { error: error.message })) return boardFailure();
						return {
							ok: false,
							taskId: id,
							state: "failed",
							target,
							error
						};
					}
					const snapshot = collector.snapshot();
					const stored = {
						summary: snapshot.latestText === "" ? "(streaming: no assistant text yet)" : snapshot.latestText,
						sessionId
					};
					if (!finalize("running", { result: stored })) return boardFailure();
					return {
						ok: true,
						taskId: id,
						state: "running",
						target,
						result: {
							...stored,
							pending: true
						}
					};
				}
				const outcome = await collector.wait(args.maxDurationMs, exec.signal);
				if (outcome.kind === "timeout") {
					const message = `dispatch timed out after ${args.maxDurationMs}ms (${outcome.eventCount} event(s) received)`;
					if (!finalize("expired", { error: message })) return boardFailure();
					return failure("timeout", message, {
						taskId: id,
						target,
						state: "expired"
					});
				}
				if (outcome.kind === "aborted") {
					const message = "tool call aborted before a final reply arrived";
					if (!finalize("failed", { error: message })) return boardFailure();
					return failure("timeout", message, {
						taskId: id,
						target
					});
				}
				if (outcome.kind === "failure") {
					const error = meshErrorFrom(outcome.failure.code, outcome.failure.message);
					if (!finalize("failed", { error: error.message })) return boardFailure();
					return {
						ok: false,
						taskId: id,
						state: "failed",
						target,
						error
					};
				}
				const result = {
					summary: outcome.summary.trim() === "" ? "(no assistant text received)" : outcome.summary,
					sessionId
				};
				if (!finalize("done", { result })) return boardFailure();
				return {
					ok: true,
					taskId: id,
					state: "done",
					target,
					result
				};
			} catch (err) {
				const error = toMeshError(err);
				if (!settled) try {
					if (!runtime.board.update(id, {
						state: error.code === "timeout" ? "expired" : "failed",
						error: error.message
					}, fence)) console.warn(`[mesh] task "${id}" was fenced out before the failure could be recorded`);
				} catch (boardError) {
					console.warn(`[mesh] failed to record dispatch failure for task "${id}":`, boardError);
				}
				return {
					ok: false,
					taskId: id,
					state: error.code === "timeout" ? "expired" : "failed",
					target,
					error
				};
			} finally {
				collector?.dispose();
				if (unsubscribe !== void 0) try {
					unsubscribe();
				} catch {}
				if (ownsLease) {
					try {
						runtime.board.release(id, owner);
					} catch {}
					ownsLease = false;
				}
			}
		}
	};
}
// src/api/dispatch.ts
/**
* Browser-triggered dispatch, served next to the read-only snapshot.
*
* The model reaches the same code through the `mesh_dispatch` tool; this route
* exists so a person can send a message to a remote workspace from the page
* without waiting for a chat turn. It reuses the tool definition verbatim, so
* validation, the lease invariant, the reply collector and the error vocabulary
* cannot drift between the two entry points.
*/
const MESH_DISPATCH_PATH = "/api/mesh/dispatch";
/** Arguments the page may send; everything else is rejected before the tool runs. */
const DISPATCH_ARG_KEYS = [
	"workspaceId",
	"objective",
	"nodeId",
	"context",
	"acceptance",
	"sessionMode",
	"sessionId",
	"maxDurationMs",
	"replyMode"
];
async function handleDispatch(request, control) {
	let body;
	try {
		body = await request.json();
	} catch {
		return jsonResponse({
			ok: false,
			error: "body must be JSON"
		}, 400);
	}
	if (body === null || typeof body !== "object" || Array.isArray(body)) return jsonResponse({
		ok: false,
		error: "body must be a JSON object"
	}, 400);
	const record = body;
	const args = {};
	for (const key of DISPATCH_ARG_KEYS) if (record[key] !== void 0) args[key] = record[key];
	if (typeof args.workspaceId !== "string" || args.workspaceId.trim() === "") return jsonResponse({
		ok: false,
		error: "workspaceId is required"
	}, 400);
	if (typeof args.objective !== "string" || args.objective.trim() === "") return jsonResponse({
		ok: false,
		error: "objective is required"
	}, 400);
	const tool = createMeshDispatchTool(control.runtime);
	try {
		return jsonResponse(await tool.execute(args, {}), 200);
	} catch (err) {
		return jsonResponse({
			ok: false,
			error: err instanceof Error ? err.message : String(err)
		}, 400);
	}
}
/** Serve POST /api/mesh/dispatch. */
function mountMeshDispatchRoute(ctx, control) {
	return mountExactRoute(ctx, {
		path: MESH_DISPATCH_PATH,
		methods: ["POST"],
		fetch: async (request) => {
			try {
				return await handleDispatch(request, control);
			} catch (err) {
				return jsonResponse({
					ok: false,
					error: err instanceof Error ? err.message : String(err)
				}, 500);
			}
		}
	});
}
function registerMeshDispatchRoute(ctx, runtime) {
	withConnection(ctx, (inner) => mountMeshDispatchRoute(inner, { runtime }));
}
// src/api/workspaces.ts
/**
* This node's own native workspaces, for peers that want to list them.
*
* The mesh does not invent workspace ids: a remote caller must target the id the
* owning DSH instance already knows, so the owner publishes its registry here and
* the caller consumes it (see transport/typert.ts). Reading is all this route
* does — creating or mutating a workspace stays a local, human action.
*/
const MESH_WORKSPACES_PATH = "/api/mesh/workspaces";
function buildWorkspacesPayload(registry) {
	if (registry === void 0) return {
		ok: true,
		workspaces: [],
		note: "workspaceRegistry is not available in this composition"
	};
	return {
		ok: true,
		workspaces: (registry.list() ?? []).map((item) => ({
			workspaceId: String(item.id ?? ""),
			title: typeof item.title === "string" ? item.title : "",
			path: typeof item.path === "string" ? item.path : "",
			sessions: Array.isArray(item.sessionIds) ? item.sessionIds.length : 0,
			sessionIds: Array.isArray(item.sessionIds) ? item.sessionIds.map(String) : []
		}))
	};
}
/**
* Read the registry without declaring a hard injection: mesh stays loadable in
* compositions that do not mount the workspace domain.
*/
function readWorkspaceRegistry(ctx) {
	const candidate = ctx;
	if (candidate === void 0 || candidate === null) return void 0;
	let service;
	try {
		service = typeof candidate.get === "function" ? candidate.get("workspaceRegistry") : candidate.workspaceRegistry;
	} catch {
		return;
	}
	if (service === null || typeof service !== "object") return void 0;
	return typeof service.list === "function" ? service : void 0;
}
function mountMeshWorkspacesRoute(ctx, registry) {
	return mountExactRoute(ctx, {
		path: MESH_WORKSPACES_PATH,
		methods: ["GET"],
		fetch: async () => jsonResponse(buildWorkspacesPayload(registry()))
	});
}
function registerMeshWorkspacesRoute(ctx, source) {
	withConnection(ctx, (inner) => mountMeshWorkspacesRoute(inner, () => readWorkspaceRegistry(source)));
}
// src/api/session.ts
/**
* Read the tail of a remote session, for the page's conversation viewer.
*
* History lives on the owning machine; this route asks the transport for it and
* never caches — the page polls, the peer is the only authority.
*/
const MESH_SESSION_PATH = "/api/mesh/session";
async function handleSessionRead(request, control) {
	const url = new URL(request.url);
	const nodeId = url.searchParams.get("nodeId") ?? "";
	const sessionId = url.searchParams.get("sessionId") ?? "";
	if (nodeId === "" || sessionId === "") return jsonResponse({
		ok: false,
		error: "nodeId and sessionId are required"
	}, 400);
	const rawLimit = url.searchParams.get("limit");
	const parsed = rawLimit === null ? 50 : Number(rawLimit);
	const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 200) : 50;
	const transport = control.runtime.transport;
	if (transport === void 0) return jsonResponse({
		ok: false,
		code: "unavailable",
		error: "no transport configured"
	}, 200);
	if (transport.readSession === void 0) return jsonResponse({
		ok: false,
		code: "unavailable",
		error: "the active transport cannot read session history"
	}, 200);
	try {
		return jsonResponse({
			ok: true,
			messages: await transport.readSession(nodeId, sessionId, limit)
		}, 200);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const code = typeof err.code === "string" ? err.code : void 0;
		return jsonResponse(code === void 0 ? {
			ok: false,
			error: message
		} : {
			ok: false,
			code,
			error: message
		}, 200);
	}
}
function mountMeshSessionRoute(ctx, control) {
	return mountExactRoute(ctx, {
		path: MESH_SESSION_PATH,
		methods: ["GET"],
		fetch: async (request) => {
			try {
				return await handleSessionRead(request, control);
			} catch (err) {
				return jsonResponse({
					ok: false,
					error: err instanceof Error ? err.message : String(err)
				}, 500);
			}
		}
	});
}
function registerMeshSessionRoute(ctx, runtime) {
	withConnection(ctx, (inner) => mountMeshSessionRoute(inner, { runtime }));
}
/** One page of a remote session's raw event log; the page assembles the transcript. */
const MESH_SESSION_EVENTS_PATH = "/api/mesh/session/events";
async function handleSessionEvents(request, control) {
	const url = new URL(request.url);
	const nodeId = url.searchParams.get("nodeId") ?? "";
	const sessionId = url.searchParams.get("sessionId") ?? "";
	if (nodeId === "" || sessionId === "") return jsonResponse({
		ok: false,
		error: "nodeId and sessionId are required"
	}, 400);
	const read = (name) => {
		const raw = url.searchParams.get(name);
		if (raw === null) return void 0;
		const parsed = Number(raw);
		return Number.isFinite(parsed) ? parsed : void 0;
	};
	const throughSeq = read("throughSeq");
	const beforeSeq = read("beforeSeq");
	const maxMessages = read("maxMessages");
	const transport = control.runtime.transport;
	if (transport === void 0) return jsonResponse({
		ok: false,
		code: "unavailable",
		error: "no transport configured"
	}, 200);
	if (transport.readEvents === void 0) return jsonResponse({
		ok: false,
		code: "unavailable",
		error: "the active transport cannot read session events"
	}, 200);
	try {
		return jsonResponse({
			ok: true,
			...await transport.readEvents(nodeId, sessionId, {
				...throughSeq === void 0 ? {} : { throughSeq },
				...beforeSeq === void 0 ? {} : { beforeSeq },
				...maxMessages === void 0 ? {} : { maxMessages }
			})
		}, 200);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const code = typeof err.code === "string" ? err.code : void 0;
		return jsonResponse(code === void 0 ? {
			ok: false,
			error: message
		} : {
			ok: false,
			code,
			error: message
		}, 200);
	}
}
/** Live assistant frames; a page folds them into the answer while it is being written. */
const MESH_SESSION_LIVE_PATH = "/api/mesh/session/live";
async function handleSessionLive(request, control) {
	const url = new URL(request.url);
	const sessionId = url.searchParams.get("sessionId") ?? "";
	if (sessionId === "") return jsonResponse({
		ok: false,
		error: "sessionId is required"
	}, 400);
	const rawSince = Number(url.searchParams.get("since") ?? "0");
	const since = Number.isFinite(rawSince) && rawSince > 0 ? rawSince : 0;
	const nodeId = url.searchParams.get("nodeId") ?? "";
	if (nodeId !== "") {
		const transport = control.runtime.transport;
		if (transport?.readAssistantLive === void 0) return jsonResponse({
			ok: false,
			code: "unavailable",
			error: "the active transport cannot read live frames"
		}, 200);
		try {
			return jsonResponse({
				ok: true,
				...await transport.readAssistantLive(nodeId, sessionId, since)
			}, 200);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const code = typeof err.code === "string" ? err.code : void 0;
			return jsonResponse(code === void 0 ? {
				ok: false,
				error: message
			} : {
				ok: false,
				code,
				error: message
			}, 200);
		}
	}
	if (control.hub === void 0) return jsonResponse({
		ok: false,
		code: "unavailable",
		error: "this Host does not retain live frames"
	}, 200);
	return jsonResponse({
		ok: true,
		...control.hub.read(sessionId, since)
	}, 200);
}
/** Open a Session on the peer's machine inside the picked Workspace. */
const MESH_SESSION_OPEN_PATH = "/api/mesh/session/open";
/** Send one prompt into a Session that lives on the peer's machine. */
const MESH_SESSION_PROMPT_PATH = "/api/mesh/session/prompt";
async function bodyOf(request) {
	try {
		const value = await request.json();
		if (value === null || typeof value !== "object" || Array.isArray(value)) return void 0;
		return value;
	} catch {
		return;
	}
}
async function handleSessionOpen(request, control) {
	const body = await bodyOf(request);
	if (body === void 0) return jsonResponse({
		ok: false,
		error: "body must be a JSON object"
	}, 400);
	const nodeId = typeof body.nodeId === "string" ? body.nodeId : "";
	const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
	if (nodeId === "" || workspaceId === "") return jsonResponse({
		ok: false,
		error: "nodeId and workspaceId are required"
	}, 400);
	const transport = control.runtime.transport;
	if (transport === void 0) return jsonResponse({
		ok: false,
		code: "unavailable",
		error: "no transport configured"
	}, 200);
	try {
		return jsonResponse({
			ok: true,
			nodeId,
			workspaceId,
			sessionId: await transport.createSession(nodeId, workspaceId)
		}, 200);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const code = typeof err.code === "string" ? err.code : void 0;
		return jsonResponse(code === void 0 ? {
			ok: false,
			error: message
		} : {
			ok: false,
			code,
			error: message
		}, 200);
	}
}
async function handleSessionPrompt(request, control) {
	const body = await bodyOf(request);
	if (body === void 0) return jsonResponse({
		ok: false,
		error: "body must be a JSON object"
	}, 400);
	const nodeId = typeof body.nodeId === "string" ? body.nodeId : "";
	const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
	const text = typeof body.text === "string" ? body.text : "";
	if (nodeId === "" || sessionId === "" || text.trim() === "") return jsonResponse({
		ok: false,
		error: "nodeId, sessionId and text are required"
	}, 400);
	const transport = control.runtime.transport;
	if (transport === void 0) return jsonResponse({
		ok: false,
		code: "unavailable",
		error: "no transport configured"
	}, 200);
	try {
		await transport.prompt(nodeId, sessionId, text);
		return jsonResponse({ ok: true }, 200);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const code = typeof err.code === "string" ? err.code : void 0;
		return jsonResponse(code === void 0 ? {
			ok: false,
			error: message
		} : {
			ok: false,
			code,
			error: message
		}, 200);
	}
}
/** Mount the page-facing routes on one Connection-bearing context. */
function registerMeshSessionPageRoutes(ctx, runtime, hub) {
	const control = hub === void 0 ? { runtime } : {
		runtime,
		hub
	};
	withConnection(ctx, (inner) => {
		return [
			mountExactRoute(inner, {
				path: MESH_SESSION_EVENTS_PATH,
				methods: ["GET"],
				fetch: async (request) => {
					try {
						return await handleSessionEvents(request, control);
					} catch (err) {
						return jsonResponse({
							ok: false,
							error: err instanceof Error ? err.message : String(err)
						}, 500);
					}
				}
			}),
			mountExactRoute(inner, {
				path: MESH_SESSION_LIVE_PATH,
				methods: ["GET"],
				fetch: async (request) => {
					try {
						return await handleSessionLive(request, control);
					} catch (err) {
						return jsonResponse({
							ok: false,
							error: err instanceof Error ? err.message : String(err)
						}, 500);
					}
				}
			}),
			mountExactRoute(inner, {
				path: MESH_SESSION_OPEN_PATH,
				methods: ["POST"],
				fetch: async (request) => {
					try {
						return await handleSessionOpen(request, control);
					} catch (err) {
						return jsonResponse({
							ok: false,
							error: err instanceof Error ? err.message : String(err)
						}, 500);
					}
				}
			}),
			mountExactRoute(inner, {
				path: MESH_SESSION_PROMPT_PATH,
				methods: ["POST"],
				fetch: async (request) => {
					try {
						return await handleSessionPrompt(request, control);
					} catch (err) {
						return jsonResponse({
							ok: false,
							error: err instanceof Error ? err.message : String(err)
						}, 500);
					}
				}
			})
		].every(Boolean);
	});
}
// src/live/assistant.ts
/** Frames retained per Session: a slow reader falls behind, it does not grow the Host. */
const RETAINED_FRAMES = 4e3;
/**
* Rolling per-Session copy of the Agent's live frames.
*
* The Hub only listens: it never drives the Agent, and a Session with no Agent
* simply has nothing to hand out.
*/
var AssistantLiveHub = class {
	streams = /* @__PURE__ */ new Map();
	/**
	* @param ctx - any Host context; the listener is global so Agents on other fibers are seen too.
	*/
	constructor(ctx) {
		const events = ctx;
		if (typeof events.on !== "function") {
			this.dispose = () => {
				this.streams.clear();
			};
			return;
		}
		const listen = events.on.bind(events);
		const dispose = listen("agent/assistant-stream", (payload) => {
			this.accept(payload);
		}, { global: true });
		const forget = listen("agent/disposed", (payload) => {
			const id = payload.agent?.session?.id;
			if (typeof id === "string") this.streams.delete(id);
		}, { global: true });
		this.dispose = () => {
			dispose();
			forget();
			this.streams.clear();
		};
	}
	dispose;
	/** Stop listening; the retained frames go with it. */
	release() {
		this.dispose();
	}
	/**
	* Keep one frame for its Session.
	* @param payload - the Host's event payload.
	*/
	accept(payload) {
		const sessionId = payload.agent?.session?.id;
		const frame = payload.frame;
		if (typeof sessionId !== "string" || frame === void 0) return;
		if (typeof frame.attemptId !== "string" || typeof frame.revision !== "number") return;
		const seq = typeof payload.agent?.session?.seq === "number" ? payload.agent.session.seq : 0;
		let stream = this.streams.get(sessionId);
		if (stream === void 0) {
			stream = {
				revision: 0,
				frames: []
			};
			this.streams.set(sessionId, stream);
		}
		if (frame.type === "start" && frame.revision === 1 && stream.revision !== 0) {
			stream.frames = [];
			stream.revision = 0;
		}
		const revision = frame.revision;
		if (revision !== stream.revision + 1) {
			stream.frames = [];
			stream.revision = revision;
			return;
		}
		stream.revision = revision;
		switch (frame.type) {
			case "start":
				stream.frames.push({
					type: "start",
					attemptId: frame.attemptId,
					revision,
					startedAfterSeq: seq === 0 ? -1 : seq - 1,
					turn: typeof frame.turn === "number" ? frame.turn : 0,
					step: typeof frame.step === "number" ? frame.step : 0
				});
				break;
			case "chunk":
				stream.frames.push({
					type: "chunk",
					attemptId: frame.attemptId,
					revision,
					index: typeof frame.index === "number" ? frame.index : 0,
					time: typeof frame.time === "number" ? frame.time : Date.now(),
					chunk: frame.chunk
				});
				break;
			case "end": {
				const outcome = frame.outcome ?? {};
				stream.frames.push({
					type: "end",
					attemptId: frame.attemptId,
					revision,
					index: typeof frame.index === "number" ? frame.index : 0,
					outcome: {
						...typeof outcome.kind === "string" ? { kind: outcome.kind } : {},
						...typeof outcome.seq === "number" ? { seq: outcome.seq } : {},
						...typeof outcome.eventType === "string" ? { eventType: outcome.eventType } : {}
					}
				});
				break;
			}
		}
		if (stream.frames.length > RETAINED_FRAMES) stream.frames = stream.frames.slice(-4e3);
	}
	/**
	* Read everything newer than one revision.
	* @param sessionId - the Session to read.
	* @param since - last revision the reader folded; 0 asks for the whole attempt.
	* @returns the current revision and the unseen frames.
	*/
	read(sessionId, since) {
		const stream = this.streams.get(sessionId);
		if (stream === void 0) return {
			revision: 0,
			frames: []
		};
		if (since >= stream.revision) return {
			revision: stream.revision,
			frames: []
		};
		const frames = stream.frames.filter((frame) => frame.revision > since);
		return {
			revision: stream.revision,
			frames
		};
	}
	/**
	* Whether a Session currently has live frames at all.
	* @param sessionId - the Session to check.
	* @returns true while an Agent is producing frames there.
	*/
	has(sessionId) {
		const stream = this.streams.get(sessionId);
		return stream !== void 0 && stream.revision > 0;
	}
};
// src/api/remote.ts
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
const MESH_REMOTE_PATH = "/api/mesh/remote";
const REMOTE_OPS = /* @__PURE__ */ new Set(["browse", "workspace-create"]);
/**
* Validate one administration call and hand it to the transport.
* @param request - the browser's POST.
* @param control - mesh runtime; its transport must offer the control capability.
* @returns the peer's answer, or a mesh-shaped failure with HTTP 200.
*/
async function handleRemote(request, control) {
	if (request.method !== "POST") return jsonResponse({
		ok: false,
		error: "method must be POST"
	}, 405);
	let body;
	try {
		body = await request.json();
	} catch {
		return jsonResponse({
			ok: false,
			error: "body must be JSON"
		}, 400);
	}
	if (body === null || typeof body !== "object" || Array.isArray(body)) return jsonResponse({
		ok: false,
		error: "body must be a JSON object"
	}, 400);
	const record = body;
	const nodeId = typeof record.nodeId === "string" ? record.nodeId.trim() : "";
	if (nodeId === "") return jsonResponse({
		ok: false,
		error: "nodeId is required"
	}, 400);
	const op = record.op;
	if (typeof op !== "string" || !REMOTE_OPS.has(op)) return jsonResponse({
		ok: false,
		error: `op must be one of ${[...REMOTE_OPS].join(" | ")}`
	}, 400);
	const path = typeof record.path === "string" ? record.path.trim() : "";
	if (op === "workspace-create" && (path === "" || !/^(?:[A-Za-z]:[\\/]|[\\/])/.test(path))) return jsonResponse({
		ok: false,
		error: "path must be an absolute directory path"
	}, 400);
	const transport = control.runtime.transport;
	if (transport?.control === void 0) return jsonResponse({
		ok: false,
		error: "transport cannot administer peers (no control capability)"
	}, 503);
	const args = { path };
	const title = typeof record.title === "string" ? record.title.trim() : "";
	if (title !== "") args.title = title;
	try {
		return jsonResponse({
			ok: true,
			value: await transport.control(nodeId, op, args)
		}, 200);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return jsonResponse({
			ok: false,
			code: typeof err.code === "string" ? err.code : "remote-failure",
			error: message
		}, 200);
	}
}
function mountMeshRemoteRoute(ctx, control) {
	return mountExactRoute(ctx, {
		path: MESH_REMOTE_PATH,
		methods: ["POST"],
		fetch: async (request) => handleRemote(request, control)
	});
}
/** Serve POST /api/mesh/remote inside Connection's authenticated fence. */
function registerMeshRemoteRoute(ctx, runtime) {
	withConnection(ctx, (inner) => mountMeshRemoteRoute(inner, { runtime }));
}
// src/api/mesh-http.ts
function readWebServer(ctx) {
	const candidate = ctx;
	if (candidate === void 0 || candidate === null) return void 0;
	let service;
	try {
		service = typeof candidate.get === "function" ? candidate.get("webServer") : candidate.webServer;
	} catch {
		return;
	}
	if (service === null || typeof service !== "object") return void 0;
	return typeof service.register === "function" ? service : void 0;
}
async function toRequest(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	const body = chunks.length === 0 ? void 0 : Buffer.concat(chunks);
	const headers = new Headers();
	const contentType = req.headers["content-type"];
	if (typeof contentType === "string") headers.set("content-type", contentType);
	return new Request(`http://mesh.invalid${req.url ?? "/"}`, {
		method: req.method ?? "POST",
		headers,
		...body === void 0 ? {} : { body: new Uint8Array(body) }
	});
}
async function writeResponse(res, response) {
	const text = await response.text();
	res.writeHead(response.status, { "content-type": response.headers.get("content-type") ?? "application/json; charset=utf-8" });
	res.end(text);
}
/**
* Register one exact-path route on the web server.
* @returns true when a web server exists and the route was mounted.
*/
function registerMeshPublicRoute(ctx, path, handler) {
	const server = readWebServer(ctx);
	if (server === void 0) return false;
	const route = {
		kind: "exact",
		path,
		handler: async (req, res) => {
			try {
				await writeResponse(res, await handler(await toRequest(req)));
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({
					ok: false,
					error: message
				}));
			}
		}
	};
	ctx.effect?.(() => {
		const dispose = server.register(route);
		return typeof dispose === "function" ? dispose : () => {};
	});
	if (ctx.effect === void 0) server.register(route);
	return true;
}
// src/api/handshake.ts
/**
* Peer asks for a mesh credential.
*
* Authenticated by the shared `meshSecret` (HMAC over nodeId + timestamp + nonce),
* not by the web login token: that is what lets a caller recover by itself after
* the peer restarts and its login token rotates.
*/
const MESH_HANDSHAKE_PATH = "/api/mesh/handshake";
async function handleHandshake(request, control) {
	const secret = control.secret();
	if (secret === void 0 || secret === "") return jsonResponse({
		ok: false,
		error: "meshSecret is not configured on this node"
	}, 503);
	let body;
	try {
		body = await request.json();
	} catch {
		return jsonResponse({
			ok: false,
			error: "body must be JSON"
		}, 400);
	}
	const now = (control.now ?? Date.now)();
	const check = verifyHandshake(secret, body, control.nonces, now);
	if (!check.ok) return jsonResponse({
		ok: false,
		error: `handshake rejected: ${check.reason}`
	}, 401);
	const claims = {
		nodeId: String(body.nodeId),
		expiresAt: now + MESH_TOKEN_TTL_MS
	};
	return jsonResponse({
		ok: true,
		token: mintMeshToken(secret, claims),
		expiresAt: claims.expiresAt
	}, 200);
}
function registerMeshHandshakeRoute(ctx, secret) {
	const nonces = new NonceCache();
	registerMeshPublicRoute(ctx, MESH_HANDSHAKE_PATH, (request) => handleHandshake(request, {
		secret,
		nonces
	}));
}
// src/api/relay.ts
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
const MESH_RELAY_PATH = "/api/mesh/relay";
/** Dictionaries a peer browse may return; a machine never answers with more. */
const MAX_BROWSE_ENTRIES = 500;
function believe(code, message) {
	return Object.assign(new Error(message), { code });
}
/**
* List the directories below one absolute path on this machine.
*
* A paired peer may browse here; the answer is directory names and paths only,
* never file contents. Symlinks are not followed on purpose: the canonical path
* is what the registry will store, and resolving a link chain here would make
* the listing disagree with the Workspace it later creates.
*
* An empty ask starts at this machine's home directory: the caller cannot know
* another machine's layout, and the answer names the path it landed on.
* @param value - the requested absolute path, or empty for the home directory.
* @returns the canonical directory and its subdirectories.
*/
async function browseDirectories(value) {
	const asked = typeof value === "string" ? value.trim() : "";
	const requested = asked === "" ? homedir() : asked;
	if (!isAbsolute(requested)) throw believe("browse-invalid", "path must be an absolute directory path");
	let canonical;
	try {
		canonical = await promises.realpath(requested);
	} catch {
		throw believe("browse-missing", `directory "${requested}" does not exist on this node`);
	}
	const stats = await promises.stat(canonical).catch(() => void 0);
	if (stats === void 0 || !stats.isDirectory()) throw believe("browse-invalid", `"${canonical}" is not a directory`);
	const rows = await promises.readdir(canonical, { withFileTypes: true });
	const entries = [];
	for (const row of rows.sort((left, right) => left.name.localeCompare(right.name))) {
		if (!row.isDirectory()) continue;
		entries.push({
			name: row.name,
			path: join(canonical, row.name)
		});
		if (entries.length >= MAX_BROWSE_ENTRIES) break;
	}
	const parent = dirname(canonical);
	return {
		path: canonical,
		parent: parent === canonical ? null : parent,
		entries
	};
}
const RELAY_OPS = /* @__PURE__ */ new Set([
	"list",
	"create",
	"prompt",
	"page",
	"workspaces",
	"browse",
	"workspace-create",
	"assistant-live"
]);
async function handleRelay(request, control) {
	const secret = control.secret();
	if (secret === void 0 || secret === "") return jsonResponse({
		ok: false,
		error: "meshSecret is not configured on this node"
	}, 503);
	let body;
	try {
		body = await request.json();
	} catch {
		return jsonResponse({
			ok: false,
			error: "body must be JSON"
		}, 400);
	}
	if (body === null || typeof body !== "object" || Array.isArray(body)) return jsonResponse({
		ok: false,
		error: "body must be a JSON object"
	}, 400);
	const record = body;
	const now = (control.now ?? Date.now)();
	const check = verifyMeshToken(secret, record.token, now);
	if (!check.ok) return jsonResponse({
		ok: false,
		error: `mesh token rejected: ${check.reason}`
	}, 401);
	const op = record.op;
	if (typeof op !== "string" || !RELAY_OPS.has(op)) return jsonResponse({
		ok: false,
		error: `op must be one of ${[...RELAY_OPS].join(" | ")}`
	}, 400);
	const args = record.args ?? {};
	const signal = new AbortController().signal;
	if (op === "workspaces") return jsonResponse({
		ok: true,
		value: control.workspaces?.() ?? {
			ok: true,
			workspaces: []
		}
	}, 200);
	if (op === "browse") try {
		return jsonResponse({
			ok: true,
			value: await browseDirectories(args.path)
		}, 200);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return jsonResponse({
			ok: false,
			code: typeof err.code === "string" ? err.code : "browse-failed",
			error: message
		}, 200);
	}
	if (op === "assistant-live") {
		const hub = control.live?.();
		if (hub === void 0) return jsonResponse({
			ok: false,
			code: "unavailable",
			error: "this Host does not retain live frames"
		}, 200);
		const sessionId = typeof args.sessionId === "string" ? args.sessionId : "";
		if (sessionId === "") return jsonResponse({
			ok: false,
			error: "sessionId is required"
		}, 400);
		const rawSince = args.since;
		const since = typeof rawSince === "number" && Number.isFinite(rawSince) && rawSince > 0 ? rawSince : 0;
		return jsonResponse({
			ok: true,
			value: hub.read(sessionId, since)
		}, 200);
	}
	if (op === "workspace-create") {
		const registry = control.registry?.();
		if (registry === void 0 || typeof registry.create !== "function") return jsonResponse({
			ok: false,
			code: "no-registry",
			error: "workspaceRegistry.create is not available in this composition"
		}, 503);
		const target = typeof args.path === "string" ? args.path.trim() : "";
		if (target === "" || !isAbsolute(target)) return jsonResponse({
			ok: false,
			code: "browse-invalid",
			error: "path must be an absolute directory path"
		}, 200);
		const title = typeof args.title === "string" ? args.title.trim() : "";
		try {
			return jsonResponse({
				ok: true,
				value: await registry.create(target, title === "" ? void 0 : title)
			}, 200);
		} catch (err) {
			return jsonResponse({
				ok: false,
				code: "workspace-create-failed",
				error: err instanceof Error ? err.message : String(err)
			}, 200);
		}
	}
	const controller = control.controller();
	if (controller === void 0) return jsonResponse({
		ok: false,
		error: "sessionController is not available in this composition"
	}, 503);
	try {
		switch (op) {
			case "list": return jsonResponse({
				ok: true,
				value: await controller.list(args._request ?? {}, signal)
			}, 200);
			case "create": return jsonResponse({
				ok: true,
				value: await controller.create(args.request ?? {})
			}, 200);
			case "page": return jsonResponse({
				ok: true,
				value: await controller.page(args.request ?? {}, signal)
			}, 200);
			case "prompt": return jsonResponse({
				ok: true,
				value: await controller.prompt(args.request ?? {}, signal)
			}, 200);
			default: return jsonResponse({
				ok: false,
				error: "unreachable"
			}, 500);
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const code = typeof err.code === "string" ? err.code : void 0;
		return jsonResponse(code === void 0 ? {
			ok: false,
			error: message
		} : {
			ok: false,
			code,
			error: message
		}, 200);
	}
}
/** Read `ctx.sessionController` without a hard injection. */
function readSessionController(ctx) {
	const candidate = ctx;
	if (candidate === void 0 || candidate === null) return void 0;
	let service;
	try {
		service = typeof candidate.get === "function" ? candidate.get("sessionController") : candidate.sessionController;
	} catch {
		return;
	}
	if (service === null || typeof service !== "object") return void 0;
	const record = service;
	return [
		"list",
		"create",
		"prompt",
		"page"
	].every((method) => typeof record[method] === "function") ? service : void 0;
}
function registerMeshRelayRoute(ctx, source, secret, workspaces, registry, live) {
	const control = {
		secret,
		controller: () => readSessionController(source),
		...workspaces === void 0 ? {} : { workspaces },
		...registry === void 0 ? {} : { registry },
		...live === void 0 ? {} : { live }
	};
	registerMeshPublicRoute(ctx, MESH_RELAY_PATH, (request) => handleRelay(request, control));
}
// src/tools/list-nodes.ts
const OUTPUT_SCHEMA$1 = {
	type: "object",
	additionalProperties: false,
	properties: {
		transport: TRANSPORT_REPORT_SCHEMA,
		peers: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					nodeId: { type: "string" },
					label: { type: "string" },
					endpoint: { type: "string" },
					online: {
						type: "boolean",
						description: "SPEC §18 NodeDescriptor.online; true only when a transport receipt says online."
					},
					status: {
						type: "string",
						enum: [
							"online",
							"offline",
							"unknown"
						],
						description: "online/offline come from a transport receipt; unknown means no receipt was seen."
					},
					source: {
						type: "string",
						enum: [
							"assignment",
							"transport",
							"both"
						],
						description: "Where this peer entry came from."
					},
					lastSeenAt: {
						type: "number",
						description: "Unix milliseconds from the transport receipt, when known."
					},
					workspaces: {
						type: "array",
						items: WORKSPACE_VIEW_SCHEMA
					},
					assignedWorkspaceIds: {
						type: "array",
						items: { type: "string" },
						description: "Workspaces assignment.yml routes to this node."
					}
				},
				required: [
					"nodeId",
					"label",
					"endpoint",
					"online",
					"status",
					"source",
					"workspaces",
					"assignedWorkspaceIds"
				]
			}
		},
		notes: {
			type: "array",
			items: { type: "string" }
		}
	},
	required: [
		"transport",
		"peers",
		"notes"
	]
};
/**
* mesh_list_nodes — the mesh roster, derived from assignment.yml plus transport
* receipts. DSH has no core roster service (spike p1 §2.3), so nothing here
* calls ctx.*; status stays "unknown" until a receipt proves otherwise.
*/
function createMeshListNodesTool(runtime) {
	return {
		name: "mesh_list_nodes",
		description: "列出 mesh 已知节点：assignment.yml 声明的节点/工作区与传输回执合并。可用 nodeId 或 workspaceId 过滤；没有配置传输时节点状态为 unknown，绝不伪造 online。不会调用 DSH 核心 roster API（DSH 没有这个概念）。",
		parameters: {
			type: "object",
			properties: {
				nodeId: {
					type: "string",
					description: "只返回该节点。"
				},
				workspaceId: {
					type: "string",
					description: "只返回承载该工作区的节点（assignment 或传输回执）。"
				}
			},
			additionalProperties: false
		},
		output: {
			schema: OUTPUT_SCHEMA$1,
			render: renderJson
		},
		async execute(rawArgs) {
			const args = asArgsRecord(rawArgs, "mesh_list_nodes");
			rejectUnknownArgs(args, ["nodeId", "workspaceId"], "mesh_list_nodes");
			const nodeId = optionalString(args, "nodeId", "mesh_list_nodes", { nonEmpty: true });
			const workspaceId = optionalString(args, "workspaceId", "mesh_list_nodes", { nonEmpty: true });
			const roster = await deriveRoster(runtime);
			const notes = [...roster.notes];
			let list = roster.peers;
			if (nodeId !== void 0) {
				list = list.filter((peer) => peer.nodeId === nodeId);
				if (list.length === 0) notes.push("node \"" + nodeId + "\" is not known to assignment.yml or the transport");
			}
			if (workspaceId !== void 0) {
				list = list.filter((peer) => peer.assignedWorkspaceIds.includes(workspaceId) || peer.workspaces.some((workspace) => workspace.workspaceId === workspaceId));
				if (list.length === 0) notes.push("workspace \"" + workspaceId + "\" is not assigned to a known node");
			}
			return {
				transport: transportReport(runtime),
				peers: list.map(wirePeer),
				notes
			};
		}
	};
}
// src/tools/status.ts
const OUTPUT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		plugin: { type: "string" },
		transport: TRANSPORT_REPORT_SCHEMA,
		assignment: {
			type: "object",
			additionalProperties: false,
			properties: {
				configured: {
					type: "boolean",
					description: "Whether assignmentFile was configured and parsed."
				},
				file: {
					type: "string",
					description: "Absolute path of the parsed assignment file; empty when none."
				},
				nodes: {
					type: "integer",
					description: "Number of node entries declared in assignment.yml."
				},
				assignments: {
					type: "integer",
					description: "Number of workspace -> node assignments declared."
				}
			},
			required: [
				"configured",
				"file",
				"nodes",
				"assignments"
			]
		},
		board: {
			type: "object",
			additionalProperties: false,
			properties: {
				total: { type: "integer" },
				queued: { type: "integer" },
				dispatched: { type: "integer" },
				running: { type: "integer" },
				done: { type: "integer" },
				failed: { type: "integer" },
				expired: { type: "integer" }
			},
			required: [
				"total",
				"queued",
				"dispatched",
				"running",
				"done",
				"failed",
				"expired"
			]
		},
		lifecycle: {
			type: "object",
			additionalProperties: false,
			properties: {
				state: {
					type: "string",
					description: "running | draining | offline"
				},
				supervisor: {
					type: "string",
					description: "systemd | docker | pm2 | unknown"
				},
				pid: { type: "integer" },
				startedAt: {
					type: "number",
					description: "Unix milliseconds when the controller was created."
				}
			},
			required: [
				"state",
				"supervisor",
				"pid",
				"startedAt"
			]
		}
	},
	required: [
		"plugin",
		"transport",
		"assignment",
		"board",
		"lifecycle"
	]
};
const TASK_STATES = [
	"queued",
	"dispatched",
	"running",
	"done",
	"failed",
	"expired"
];
function countTasks(runtime) {
	const counts = {
		total: 0,
		queued: 0,
		dispatched: 0,
		running: 0,
		done: 0,
		failed: 0,
		expired: 0
	};
	for (const task of runtime.board.list()) {
		counts.total += 1;
		if (TASK_STATES.includes(task.state)) counts[task.state] += 1;
	}
	return counts;
}
/**
* mesh_status — local health snapshot. This is an EXTRA mesh-level overview
* outside SPEC §18 (it does not replace mesh_task_status). It never performs a
* cross-machine call, so it stays useful precisely when no transport is
* configured (SPEC §9.4.2).
*/
function createMeshStatusTool(runtime) {
	return {
		name: "mesh_status",
		description: "报告 workspace mesh 的本地状态：传输是否就绪、assignment.yml 摘要、任务板各状态计数、进程生命周期。这是 SPEC §18 之外的补充总览工具（不替代 mesh_task_status）；不发起跨机调用，没有传输时也能安全调用。",
		parameters: {
			type: "object",
			properties: {},
			additionalProperties: false
		},
		output: {
			schema: OUTPUT_SCHEMA,
			render: renderJson
		},
		async execute() {
			const lifecycle = runtime.lifecycle.status();
			return {
				plugin: PLUGIN_NAME,
				transport: transportReport(runtime),
				assignment: {
					configured: runtime.assignment !== void 0,
					file: runtime.assignment?.file ?? "",
					nodes: runtime.assignment?.nodes.length ?? 0,
					assignments: runtime.assignment?.assignments.length ?? 0
				},
				board: countTasks(runtime),
				lifecycle: {
					state: lifecycle.state,
					supervisor: lifecycle.supervisor,
					pid: lifecycle.pid,
					startedAt: lifecycle.startedAt
				}
			};
		}
	};
}
// src/tools/task-status.ts
const TASK_STATE_VALUES = [
	"queued",
	"dispatched",
	"running",
	"done",
	"failed",
	"expired"
];
const TARGET_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		nodeId: { type: "string" },
		workspaceId: { type: "string" }
	},
	required: ["nodeId", "workspaceId"]
};
const POLICY_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		sessionMode: {
			type: "string",
			enum: ["new", "resume"]
		},
		sessionId: { type: "string" },
		maxDurationMs: { type: "number" },
		replyMode: {
			type: "string",
			enum: ["final", "stream"]
		}
	},
	required: ["sessionMode", "replyMode"]
};
const LEASE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		owner: { type: "string" },
		fencingToken: { type: "integer" },
		expiresAt: { type: "number" }
	},
	required: [
		"owner",
		"fencingToken",
		"expiresAt"
	]
};
const RESULT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		summary: { type: "string" },
		sessionId: { type: "string" },
		artifacts: {
			type: "array",
			items: { type: "string" }
		}
	},
	required: ["summary"]
};
/** Mirrors the Task envelope from SPEC §5.3 / §18. */
const TASK_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		taskId: { type: "string" },
		target: TARGET_SCHEMA,
		objective: { type: "string" },
		context: { type: "string" },
		acceptance: {
			type: "array",
			items: { type: "string" }
		},
		policy: POLICY_SCHEMA,
		lease: LEASE_SCHEMA,
		state: {
			type: "string",
			enum: [...TASK_STATE_VALUES]
		},
		createdAt: { type: "number" },
		updatedAt: { type: "number" },
		result: RESULT_SCHEMA,
		error: { type: "string" }
	},
	required: [
		"taskId",
		"target",
		"objective",
		"policy",
		"lease",
		"state",
		"createdAt",
		"updatedAt"
	]
};
/**
* mesh_task_status — SPEC §18 name, backed directly by TaskBoard.get().
* The board is in-memory in P2, so only tasks created by this plugin instance
* are visible; mesh_task_wait (which needs durable storage) is deferred.
*/
function createMeshTaskStatusTool(runtime) {
	return {
		name: "mesh_task_status",
		description: "读取任务板上某个 taskId 的当前状态（SPEC §18 的 mesh_task_status）：返回 Task（目标、状态、租约、结果或错误）。P2 的任务板在进程内存中；异步等待（mesh_task_wait）尚未实现。",
		parameters: {
			type: "object",
			properties: { taskId: {
				type: "string",
				description: "mesh_dispatch 返回的 taskId。"
			} },
			required: ["taskId"],
			additionalProperties: false
		},
		output: {
			schema: TASK_SCHEMA,
			render: renderJson
		},
		async execute(rawArgs) {
			const args = asArgsRecord(rawArgs, "mesh_task_status");
			rejectUnknownArgs(args, ["taskId"], "mesh_task_status");
			const taskId = requiredString(args, "taskId", "mesh_task_status");
			const task = runtime.board.get(taskId);
			if (task === void 0) throw new Error(`mesh_task_status: task "${taskId}" is not on this host's in-memory board`);
			return task;
		}
	};
}
// src/tools/index.ts
/**
* SPEC §18 is the external naming contract. P2 implements a subset and records
* every deviation explicitly:
* - mesh_list_nodes = SPEC §18 mesh_list_nodes. DSH has no core roster service
*   (spike p1 §2.3), so the list is derived from assignment.yml plus transport
*   receipts. Workspaces are embedded per node, which covers
*   mesh_list_workspaces(nodeId?) without a second tool.
* - mesh_status is an EXTRA mesh-level overview tool, outside SPEC §18. It does
*   not replace mesh_task_status.
* - mesh_dispatch keeps SPEC §18's arguments, but blocks until the final reply
*   and returns { taskId, state, target, result|error } instead of { taskId }.
*   The async "taskId + mesh_task_wait" model needs a durable task store and is
*   deferred to a later increment.
* - mesh_task_status is implemented on TaskBoard.get() (SPEC §18 name).
* - Deferred: mesh_task_wait, mesh_cancel, mesh_lifecycle, mesh_plugin_*,
*   mesh_call, mesh_grants.
*/
/** The P2 tools, in registration order. */
function createMeshTools(runtime) {
	return [
		createMeshListNodesTool(runtime),
		createMeshStatusTool(runtime),
		createMeshDispatchTool(runtime),
		createMeshTaskStatusTool(runtime)
	];
}
/**
* Register the P2 tool surface on the host tool runtime. `register` is itself an
* effect in DSH, so disposal is automatic; the returned definitions let tests
* assert exactly what the model will see.
*/
function registerMeshTools(host, runtime) {
	const definitions = createMeshTools(runtime);
	for (const definition of definitions) host.tools.register(definition);
	return definitions;
}
// src/config-envelope.gen.ts
const CONFIG_ENVELOPE = {
	"uid": 40,
	"refs": {
		"0": {
			"type": "const",
			"meta": {},
			"value": "auto"
		},
		"4": {
			"type": "union",
			"meta": {
				"default": "auto",
				"description": "transport: 目前只有 auto（尚无跨机传输实现）; 保存后重启生效",
				"volatile": true
			},
			"list": [0]
		},
		"6": {
			"type": "string",
			"meta": { "description": "节点 id, 与 assignment.yml 一致" }
		},
		"8": {
			"type": "string",
			"meta": { "description": "对端 web host 的 HTTP(S) 根, 如 https://peer.example.com:3211" }
		},
		"10": {
			"type": "string",
			"meta": { "description": "对端当前登录 token (?token= 的值); 对端重启后会轮换" }
		},
		"11": {
			"type": "object",
			"meta": { "default": {} },
			"dict": {
				"nodeId": 6,
				"baseUrl": 8,
				"token": 10
			}
		},
		"15": {
			"type": "array",
			"meta": {
				"default": [],
				"description": "跨机传输的对端清单; 为空 = 不启用跨机传输; 保存后重启生效",
				"volatile": true
			},
			"inner": 11
		},
		"19": {
			"type": "string",
			"meta": {
				"default": "",
				"description": "对端握手共享密钥; 配置后走 relay 模式, 不再依赖会轮换的登录 token",
				"volatile": true
			}
		},
		"23": {
			"type": "string",
			"meta": {
				"default": "",
				"description": "assignment.yml 路径, 相对宿主进程 cwd (容器内为 /data/workspace); 留空 = 不加载",
				"volatile": true
			}
		},
		"29": {
			"type": "number",
			"meta": {
				"step": 1,
				"min": 0,
				"default": 9e5,
				"description": "任务租约时长 (毫秒)",
				"volatile": true
			}
		},
		"35": {
			"type": "number",
			"meta": {
				"step": 1,
				"min": 0,
				"default": 12e4,
				"description": "mesh_dispatch 等待最终回复的超时 (毫秒)",
				"volatile": true
			}
		},
		"39": {
			"type": "string",
			"meta": {
				"default": "mesh-lead",
				"description": "任务板租约归属者标识",
				"volatile": true
			}
		},
		"40": {
			"type": "object",
			"meta": { "default": {} },
			"dict": {
				"transport": 4,
				"peers": 15,
				"meshSecret": 19,
				"assignmentFile": 23,
				"leaseMs": 29,
				"dispatchTimeoutMs": 35,
				"leaseOwner": 39
			}
		}
	}
};
// src/config.ts
/** Read a config field that may be a volatile reference or a plain value. */
function readLive(value, fallback) {
	if (value === void 0) return fallback;
	if (typeof value === "object" && value !== null && "get" in value) return value.get();
	return value;
}
/** Field specs mirrored from scripts/gen-config-schema.mjs (single source of truth lives there). */
const FIELDS = {
	transport: {
		type: "enum",
		values: /* @__PURE__ */ new Set(["auto"]),
		fallback: "auto"
	},
	meshSecret: {
		type: "string",
		fallback: ""
	},
	assignmentFile: {
		type: "string",
		fallback: ""
	},
	leaseMs: {
		type: "integer",
		fallback: 9e5
	},
	dispatchTimeoutMs: {
		type: "integer",
		fallback: 12e4
	},
	leaseOwner: {
		type: "string",
		fallback: "mesh-lead"
	}
};
function validatePeers(raw) {
	if (!Array.isArray(raw)) return { issue: "\"peers\" must be an array" };
	const value = [];
	const keys = [
		"nodeId",
		"baseUrl",
		"token"
	];
	for (let index = 0; index < raw.length; index += 1) {
		const entry = raw[index];
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return { issue: `"peers[${index}]" must be an object` };
		const record = entry;
		for (const key of Object.keys(record)) if (!keys.includes(key)) return { issue: `"peers[${index}]" has unknown field "${key}"` };
		for (const key of keys) {
			const field = record[key];
			if (typeof field !== "string" || field.trim() === "") return { issue: `"peers[${index}].${key}" must be a non-empty string` };
		}
		value.push({
			nodeId: String(record.nodeId).trim(),
			baseUrl: String(record.baseUrl).trim(),
			token: String(record.token)
		});
	}
	return { value };
}
function validate(input) {
	if (input === void 0 || input === null) input = {};
	if (typeof input !== "object" || Array.isArray(input)) return { issues: [{ message: "expected an object" }] };
	const source = input;
	const known = /* @__PURE__ */ new Set([...Object.keys(FIELDS), "peers"]);
	for (const key of Object.keys(source)) if (!known.has(key)) return { issues: [{
		message: `unknown field "${key}"`,
		path: [key]
	}] };
	const value = {};
	for (const key of Object.keys(FIELDS)) {
		const spec = FIELDS[key];
		const raw = source[key];
		if (raw === void 0 || raw === null) {
			value[key] = spec.fallback;
			continue;
		}
		if (spec.type === "enum") {
			if (typeof raw !== "string" || !spec.values.has(raw)) return { issues: [{
				message: `"${key}" must be one of ${[...spec.values].join(" | ")}`,
				path: [key]
			}] };
			value[key] = raw;
		} else if (spec.type === "string") {
			if (typeof raw !== "string") return { issues: [{
				message: `"${key}" must be a string`,
				path: [key]
			}] };
			value[key] = raw;
		} else {
			if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw) || raw < 0) return { issues: [{
				message: `"${key}" must be a non-negative integer`,
				path: [key]
			}] };
			value[key] = raw;
		}
	}
	if (source.peers !== void 0) {
		const peers = validatePeers(source.peers);
		if (peers.issue !== void 0) return { issues: [{
			message: peers.issue,
			path: ["peers"]
		}] };
		value.peers = peers.value;
	}
	return { value };
}
/**
* Schema-face projection hints mirrored from scripts/gen-config-schema.mjs,
* so the plain fallback stays form-visible: dsh-settings' volatileForm()
* reads node.type / node.meta.volatile / node.dict.
*/
const HINTS = {
	transport: { label: "transport: 目前只有 auto（尚无跨机传输实现）; 保存后重启生效" },
	meshSecret: { label: "对端握手共享密钥; 配置后走 relay 模式, 不再依赖会轮换的登录 token" },
	assignmentFile: { label: "assignment.yml 路径, 相对宿主进程 cwd; 留空 = 不加载" },
	leaseMs: { label: "任务租约时长 (毫秒)" },
	dispatchTimeoutMs: { label: "mesh_dispatch 等待最终回复的超时 (毫秒)" },
	leaseOwner: { label: "任务板租约归属者标识" }
};
/** Plain two-face schema used when the schemastery runtime is unavailable. */
function fallbackSchema() {
	const dict = {};
	for (const [key, spec] of Object.entries(FIELDS)) {
		if (spec === void 0) continue;
		dict[key] = {
			type: spec.type === "enum" ? "union" : spec.type === "integer" ? "number" : "string",
			meta: {
				volatile: true,
				default: spec.fallback,
				description: HINTS[key]?.label ?? ""
			}
		};
	}
	return {
		type: "object",
		meta: {},
		dict,
		toJSON: () => CONFIG_ENVELOPE,
		"~standard": { validate }
	};
}
/**
* The exported Config schema. Rehydrated schemastery object when the optional
* peer is resolvable (full native settings-form compatibility), plain face
* otherwise. Top-level await is safe: the host loads plugins as ESM.
*/
let schema;
try {
	const { default: Schema } = await import("@deepseek-ai/schemastery");
	schema = Schema(CONFIG_ENVELOPE);
} catch {
	schema = fallbackSchema();
}
const Config = schema;
// src/index.ts
/** Cordis registration name; mesh_status reports the same string (F-10). */
const name = PLUGIN_NAME;
/**
* `tools` is required (without it cordis never injects the tool runtime, spike §2.1);
* `webServer` is optional — the peer handshake/relay routes need a raw HTTP seat
* below the browser fence, and a headless composition simply does not have one.
*/
const inject = {
	tools: true,
	webServer: null
};
function apply(ctx, rawConfig = {}) {
	const entryConfig = {
		...rawConfig,
		transport: readLive(rawConfig.transport, "auto"),
		leaseMs: readLive(rawConfig.leaseMs, 9e5),
		dispatchTimeoutMs: readLive(rawConfig.dispatchTimeoutMs, 12e4),
		leaseOwner: readLive(rawConfig.leaseOwner, "mesh-lead")
	};
	const overrideFile = meshConfigPath();
	const override = readConfigOverride(overrideFile);
	const config = {
		...entryConfig,
		...override.transport !== void 0 ? { transport: override.transport } : {},
		...override.peers !== void 0 ? { peers: override.peers } : {},
		...override.meshSecret !== void 0 ? { meshSecret: override.meshSecret } : {},
		...override.leaseMs !== void 0 ? { leaseMs: override.leaseMs } : {},
		...override.dispatchTimeoutMs !== void 0 ? { dispatchTimeoutMs: override.dispatchTimeoutMs } : {},
		...override.leaseOwner !== void 0 ? { leaseOwner: override.leaseOwner } : {}
	};
	const board = createInMemoryBoard();
	let transport;
	let transportError;
	const rawAssignment = rawConfig.assignmentFile;
	const entryAssignmentFile = typeof rawAssignment === "string" ? rawAssignment : rawAssignment !== null && typeof rawAssignment === "object" && "get" in rawAssignment ? String(rawAssignment.get() ?? "") : "";
	const assignmentFile = override.assignmentFile !== void 0 ? override.assignmentFile : entryAssignmentFile;
	let assignment;
	if (assignmentFile !== "") assignment = loadAssignmentTable(assignmentFile);
	const peers = config.peers ?? [];
	if (peers.length > 0) transport = createTypertTransport({
		peers,
		listAssigned: (nodeId) => (assignment?.assignments ?? []).filter((route) => route.nodeId === nodeId && typeof route.cwd === "string" && route.cwd !== "").map((route) => ({
			workspaceId: route.workspaceId,
			cwd: route.cwd
		})),
		...config.meshSecret === void 0 || config.meshSecret === "" ? {} : { meshSecret: config.meshSecret },
		resolveWorkspace: (workspaceId) => {
			const route = assignment?.assignments.find((item) => item.workspaceId === workspaceId);
			if (route?.cwd === void 0 || route.cwd === "") return void 0;
			return {
				nodeId: route.nodeId,
				cwd: route.cwd
			};
		}
	});
	else transportError = "no peers configured; add peers to the mesh config (docs/reference/config.md §2)";
	const lifecycle = createSelfRestartController();
	const toolConfig = {
		transportMode: config.transport,
		leaseMs: config.leaseMs,
		leaseOwner: config.leaseOwner,
		dispatchTimeoutMs: config.dispatchTimeoutMs
	};
	const toolRuntime = {
		board,
		transport,
		transportError,
		assignment,
		lifecycle,
		config: toolConfig
	};
	const tools = ctx.tools;
	if (tools === void 0) console.warn("[mesh] tool runtime unavailable: mesh_* tools were not registered");
	else {
		registerMeshTools({ tools }, toolRuntime);
		console.info("[mesh] registered mesh_list_nodes / mesh_status / mesh_dispatch / mesh_task_status");
	}
	const stateExtras = () => ({
		assignmentFile: toolRuntime.assignment?.file ?? "",
		configFile: overrideFile
	});
	registerMeshStateRoute(ctx, toolRuntime, stateExtras);
	registerMeshConfigRoute(ctx, {
		runtime: toolRuntime,
		file: overrideFile,
		extras: stateExtras
	});
	registerMeshDispatchRoute(ctx, toolRuntime);
	registerMeshWorkspacesRoute(ctx, ctx);
	registerMeshSessionRoute(ctx, toolRuntime);
	const liveHub = new AssistantLiveHub(ctx);
	ctx.effect(() => () => {
		liveHub.release();
	}, "mesh: assistant live frames");
	registerMeshSessionPageRoutes(ctx, toolRuntime, liveHub);
	registerMeshRemoteRoute(ctx, toolRuntime);
	const meshSecret = () => config.meshSecret ?? "";
	if (meshSecret() !== "") {
		registerMeshHandshakeRoute(ctx, meshSecret);
		registerMeshRelayRoute(ctx, ctx, meshSecret, () => buildWorkspacesPayload(readWorkspaceRegistry(ctx)), () => readWorkspaceRegistry(ctx), () => liveHub);
		console.info("[mesh] peer handshake + relay mounted (meshSecret configured)");
	}
	if (!transport) console.info("[mesh] loaded without a transport: mesh_* tools will report \"no transport configured\"");
	ctx.effect(() => () => {
		console.info("[mesh] disposed");
	});
}
export { AssignmentFileError, Config, HOT_CONFIG_KEYS, MAX_TASK_ROWS, MESH_CONFIG_PATH, MESH_DISPATCH_PATH, MESH_HANDSHAKE_PATH, MESH_RELAY_PATH, MESH_REMOTE_PATH, MESH_SESSION_EVENTS_PATH, MESH_SESSION_OPEN_PATH, MESH_SESSION_PATH, MESH_SESSION_PROMPT_PATH, MESH_STATE_PATH, MESH_STATE_VERSION, MESH_WORKSPACES_PATH, RESTART_CONFIG_KEYS, apply, buildMeshState, buildWorkspacesPayload, createSelfRestartController, createTaskId, deriveRoster, detectSupervisor, findAssignmentNode, findAssignmentRoute, handleConfigSave, handleDispatch, handleHandshake, handleRelay, handleRemote, handleSessionEvents, handleSessionOpen, handleSessionPrompt, handleSessionRead, inject, loadAssignmentTable, meshConfigPath, mountMeshRemoteRoute, name, parseAssignment, readConfigOverride, readSessionController, readWorkspaceRegistry, recentTasks, registerMeshConfigRoute, registerMeshDispatchRoute, registerMeshHandshakeRoute, registerMeshRelayRoute, registerMeshRemoteRoute, registerMeshSessionPageRoutes, registerMeshSessionRoute, registerMeshStateRoute, registerMeshTools, registerMeshWorkspacesRoute, sanitizeOverride, wirePeer, writeConfigOverride };
