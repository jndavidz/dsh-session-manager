import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { defineDomain } from "@deepseek-ai/dsh-storage-domain";
import { z } from "zod";
import { cpSync, existsSync } from "node:fs";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { decompress } from "fzstd";
//#region src/index.ts
const name = "dsh-session-manager";
const inject = [
	"webServer",
	"sessionPersistence",
	"workspaceRegistry",
	"agents",
	"storageDomain",
	"loader",
	"agentPresets"
];
const ROUTE_PREFIX = "/dsh-session-manager";
const MAX_BODY_BYTES = 65536;
const SESSION_ID_RE = /^(session-)?[0-9a-fA-F-]+$/;
/** Maximum trash entries kept; the oldest overflow is purged automatically. */
const TRASH_LIMIT = 10;
function openFolderCommand(platform) {
	if (platform === "win32") return "explorer";
	if (platform === "darwin") return "open";
	return "xdg-open";
}
function openFolder(path, platform = process.platform) {
	return new Promise((resolve, reject) => {
		const child = spawn(openFolderCommand(platform), [path], {
			detached: true,
			stdio: "ignore"
		});
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}
const trashEntrySchema = z.object({
	sessionId: z.string(),
	cwd: z.string().optional(),
	originalPath: z.string().optional(),
	deletedAt: z.number()
});
/** The plugin's storage domain: trash entries plus the compaction threshold setting. */
const trashDomainSpec = defineDomain({
	name: "dsh_delete_session",
	version: 1,
	global: {
		schema: z.object({
			entries: z.array(trashEntrySchema),
			thresholdRatio: z.number().optional()
		}),
		initial: { entries: [] }
	},
	tables: {}
});
function trashRoot() {
	return dshHomePath("dsh-delete-session-trash");
}
function trashSessionDir(sessionId) {
	return join(trashRoot(), sessionId);
}
/**
* Durable event types kept by a move — the same whitelist the official
* import pipeline uses for DSH-native logs (`dsh-chat-import`
* lib/convert/dsh.mjs): raw session logs interleave tens of thousands of
* seq-less streaming chunks plus runtime state stamps, while the write path
* (`append`) enforces a contiguous-seq contract over fully typed events.
* Everything not listed here is dropped and the survivors are renumbered
* from zero; `surfaceOp` survives, `sourceEventSeqs` is remapped.
*/
const DURABLE_EVENT_TYPES = /* @__PURE__ */ new Set([
	"turn/start",
	"step/start",
	"user/message",
	"assistant/message",
	"tool/call",
	"tool/result",
	"step/end",
	"turn/end",
	"session/title"
]);
/**
* Read and parse a session artifact (`session.jsonl` or zstd-compressed
* `session.jsonl.zstd`). The first line must be the `session` header; durable
* events are kept and renumbered. Unparsable lines (truncated stream tails,
* mid-log corruption) are tolerated and counted in `skippedLines` — the same
* contract as the official import pipeline; the caller surfaces the count.
*/
async function readSessionLog(artifactPath) {
	const raw = await readFile(artifactPath);
	let text;
	if (artifactPath.endsWith(".zstd")) text = new TextDecoder().decode(decompress(new Uint8Array(raw)));
	else text = raw.toString("utf8");
	const lines = text.split("\n").filter((line) => line.trim().length > 0);
	if (lines.length === 0) throw new Error("empty session log");
	let parsedHeader;
	try {
		parsedHeader = JSON.parse(lines[0]);
	} catch {
		throw new Error("unparsable session header");
	}
	if (parsedHeader.type !== "session") throw new Error("first line is not a session header");
	const oldToNew = /* @__PURE__ */ new Map();
	const events = [];
	let skippedLines = 0;
	for (let index = 1; index < lines.length; index++) {
		let event;
		try {
			event = JSON.parse(lines[index]);
		} catch {
			skippedLines++;
			continue;
		}
		const type = event.type;
		const seq = event.seq;
		if (typeof type !== "string" || !DURABLE_EVENT_TYPES.has(type)) continue;
		if (typeof seq !== "number" || !Number.isFinite(seq)) continue;
		const data = typeof event.data === "object" && event.data !== null ? event.data : {};
		const next = {
			type,
			seq: events.length,
			time: typeof event.time === "number" && Number.isFinite(event.time) ? event.time : Date.now(),
			data
		};
		if (typeof event.surfaceOp === "string") next.surfaceOp = event.surfaceOp;
		if (Array.isArray(event.sourceEventSeqs)) next.sourceEventSeqs = [];
		oldToNew.set(seq, next.seq);
		events.push(next);
	}
	for (const event of events) {
		if (!Array.isArray(event.sourceEventSeqs)) continue;
		event.sourceEventSeqs = event.sourceEventSeqs.map((s) => typeof s === "number" && oldToNew.has(s) ? oldToNew.get(s) : s);
	}
	const { type: _type, ...rest } = parsedHeader;
	return {
		header: rest,
		events,
		skippedLines
	};
}
function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		let data = "";
		req.on("data", (chunk) => {
			data += chunk;
			if (data.length > MAX_BODY_BYTES) {
				req.destroy();
				reject(/* @__PURE__ */ new Error("request body too large"));
			}
		});
		req.on("end", () => {
			if (data.length === 0) return resolve({});
			try {
				resolve(JSON.parse(data));
			} catch {
				reject(/* @__PURE__ */ new Error("invalid JSON body"));
			}
		});
		req.on("error", reject);
	});
}
function respond(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body)
	});
	res.end(body);
}
function parseSessionId(body) {
	const sessionId = body?.sessionId;
	if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) return void 0;
	return sessionId;
}
/** Resolve the active default preset through the official agent-presets service. */
function defaultPresetName(ctx) {
	const presets = ctx.get("agentPresets");
	if (typeof presets.defaultId !== "string" || presets.defaultId.length === 0) throw new Error("agent presets default id unavailable");
	return presets.defaultId;
}
/** Resolve the real composition path and trust instead of assuming a user path. */
async function resolvePresetComposition(ctx, name) {
	const preset = await ctx.get("agentPresets").resolve(name);
	if (typeof preset.path !== "string" || preset.path.length === 0) throw new Error(`agent preset composition path unavailable: ${name}`);
	if (preset.trust !== "system" && preset.trust !== "user") throw new Error(`agent preset trust unavailable: ${name}`);
	return {
		path: preset.path,
		trust: preset.trust
	};
}
/** Read `thresholdRatio` from the preset's compaction-basic block, if any. */
function parsePresetRatio(content) {
	const lines = content.split(/\r?\n/);
	const start = lines.findIndex((line) => /^\s*- id: compaction-basic\s*$/.test(line));
	if (start < 0) return void 0;
	for (let i = start + 1; i < lines.length; i++) {
		if (/^\s*- id: /.test(lines[i])) break;
		const match = lines[i].match(/^\s*thresholdRatio:\s*([0-9.]+)\s*$/);
		if (match !== null) return Number(match[1]);
	}
}
/**
* Update `thresholdRatio` inside the preset's `- id: compaction-basic` block:
* reuse the existing `config:`/`thresholdRatio:` lines or insert them with
* the block's indentation. Existing content and comments stay untouched.
*/
function upsertPresetRatio(content, newline, ratio) {
	const lines = content.split(/\r?\n/);
	const start = lines.findIndex((line) => /^\s*- id: compaction-basic\s*$/.test(line));
	if (start < 0) throw new Error("preset compaction-basic entry not found");
	const indentOf = (line) => (line.match(/^\s*/) ?? [""])[0];
	const base = indentOf(lines[start]);
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) if (/^\s*- id: /.test(lines[i])) {
		end = i;
		break;
	}
	const configLine = `${base}  config:`;
	const ratioLine = `${base}    thresholdRatio: ${ratio}`;
	let configIdx = -1;
	for (let i = start + 1; i < end; i++) if (/^\s*config:\s*$/.test(lines[i])) {
		configIdx = i;
		break;
	}
	if (configIdx >= 0) {
		const configIndent = indentOf(lines[configIdx]);
		let ratioIdx = -1;
		for (let i = configIdx + 1; i < end; i++) {
			if (/^\s*thresholdRatio:/.test(lines[i])) {
				ratioIdx = i;
				break;
			}
			if (indentOf(lines[i]).length <= configIndent.length && /^\S/.test(lines[i])) break;
		}
		if (ratioIdx >= 0) lines[ratioIdx] = `${configIndent}  thresholdRatio: ${ratio}`;
		else lines.splice(configIdx + 1, 0, `${configIndent}  thresholdRatio: ${ratio}`);
	} else lines.splice(end, 0, configLine, ratioLine);
	return lines.join(newline);
}
/** Read the preset file, atomically write the updated content back. */
async function writePresetComposition(path, ratio) {
	let content;
	try {
		content = await readFile(path, "utf8");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		throw new Error(`preset composition file not found: ${path}`);
	}
	const newline = content.includes("\r\n") ? "\r\n" : "\n";
	let next = upsertPresetRatio(content, newline, ratio);
	if (!next.endsWith(newline)) next += newline;
	const tmp = `${path}.tmp`;
	await writeFile(tmp, next, "utf8");
	await rename(tmp, path);
}
/**
* Sync the WorkspaceRegistry's private state cache with the durable domain
* value. There is no public unarchive API; writing the domain directly leaves
* the registry's cached state stale, so the next archiveSession() call would
* idempotently skip on the old value. This pokes the private field to keep
* both in lockstep. Fragile against a DSH upgrade, but the alternative is
* silent un-archives/archives that disagree with what clients see.
*/
function syncRegistryState(ctx, next) {
	const registry = ctx.workspaceRegistry;
	if (registry !== void 0 && "state" in registry) registry.state = next;
}
/** Remove one session id from the workspace archive set through the domain. */
async function unarchive(ctx, sessionId) {
	const workspace = ctx.storageDomain.get("workspace");
	if (workspace === void 0) return;
	const state = workspace.global.get();
	if (!state.archivedSessionIds.includes(sessionId)) return;
	const next = {
		...state,
		archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId)
	};
	await workspace.global.set(next);
	syncRegistryState(ctx, next);
}
/**
* Apply a new threshold to the compaction engines of already-open sessions.
* Sessions using the same preset share one engine in the preset's isolated
* realm; the agentPresets service's `serviceFor` is the official channel
* that reaches it (called on the HOST's service instance, so module state is
* shared). The engine reads `this.config` at every decision, so updating the
* resolved threshold field takes effect immediately. Best-effort: failures
* only warn.
*/
async function applyThresholdToLiveAgents(ctx, ratio) {
	try {
		const presets = ctx.get("agentPresets");
		if (presets?.serviceFor === void 0) return;
		const headers = await ctx.sessionPersistence.list();
		for (const header of headers) {
			const agent = ctx.agents.get(header.id);
			if (agent === void 0) continue;
			const engine = presets.serviceFor(agent, "compaction");
			if (engine === void 0 || engine.config === void 0) continue;
			engine.config.thresholdRatio = ratio;
		}
	} catch (error) {
		ctx.logger.warn("[dsh-session-manager] live-agent threshold update failed:", error);
	}
}
function apply(ctx) {
	return ctx.storageDomain.open(trashDomainSpec).then((trash) => {
		const getEntries = () => trash.global.get().entries;
		const setEntries = (entries) => {
			const current = trash.global.get();
			return trash.global.set({
				...current,
				entries
			}).catch((error) => {
				ctx.logger.warn("[dsh-session-manager] trash persist failed:", error);
				throw error;
			});
		};
		let mutationTail = Promise.resolve();
		const withMutationLock = (operation) => {
			const result = mutationTail.then(operation, operation);
			mutationTail = result.then(() => void 0, () => void 0);
			return result;
		};
		let configuredThreshold = trash.global.get().thresholdRatio ?? null;
		const setConfiguredThreshold = async (ratio) => {
			const current = trash.global.get();
			await trash.global.set({
				...current,
				thresholdRatio: ratio
			}).catch((error) => {
				ctx.logger.warn("[dsh-session-manager] threshold persist failed:", error);
				throw error;
			});
			configuredThreshold = ratio;
		};
		{
			const presets = ctx.get("agentPresets");
			ctx.on("agent/pre-step", async ({ agent }, next) => {
				try {
					if (configuredThreshold !== null && presets?.serviceFor !== void 0) {
						const engine = presets.serviceFor(agent, "compaction");
						if (engine?.config !== void 0 && engine.config.thresholdRatio !== configuredThreshold) engine.config.thresholdRatio = configuredThreshold;
					}
				} catch {}
				return next();
			}, { prepend: true });
		}
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/delete`,
			handler: async (req, res) => {
				if (req.method !== "POST") return respond(res, 405, {
					ok: false,
					error: "method-not-allowed"
				});
				let body;
				try {
					body = await readJsonBody(req);
				} catch {
					return respond(res, 400, {
						ok: false,
						error: "bad-request"
					});
				}
				const id = parseSessionId(body);
				if (id === void 0) return respond(res, 400, {
					ok: false,
					error: "invalid-session-id"
				});
				try {
					await withMutationLock(async () => {
						const meta = (await ctx.sessionPersistence.list()).find((header) => header.id === id);
						const agent = ctx.agents.get(id);
						const live = agent !== void 0;
						if (agent?.status === "running") {
							respond(res, 409, {
								ok: false,
								error: "session-live"
							});
							return;
						}
						let originalPath;
						if (meta !== void 0) {
							const location = ctx.sessionPersistence.locate(meta);
							if (location === void 0) {
								respond(res, 500, {
									ok: false,
									error: "no-artifact-location"
								});
								return;
							}
							originalPath = dirname(location.path);
						}
						const workspace = ctx.storageDomain.get("workspace");
						const wasArchived = workspace !== void 0 && workspace.global.get().archivedSessionIds.includes(id);
						const trashPath = trashSessionDir(id);
						let archiveStarted = false;
						let artifactMoved = false;
						let failureCode = "delete-failed";
						try {
							failureCode = "archive-failed";
							archiveStarted = true;
							await ctx.workspaceRegistry.archiveSession(id);
							failureCode = "delete-failed";
							{
								const currentWorkspace = ctx.storageDomain.get("workspace");
								if (currentWorkspace !== void 0) {
									const current = currentWorkspace.global.get();
									if (!current.archivedSessionIds.includes(id)) {
										const next = {
											...current,
											archivedSessionIds: [...current.archivedSessionIds, id]
										};
										await currentWorkspace.global.set(next);
										syncRegistryState(ctx, next);
										ctx.logger.debug(`[dsh-session-manager] patched archived set for ${id} (stale registry cache)`);
									}
								}
							}
							if (!live && originalPath !== void 0 && existsSync(originalPath)) {
								await mkdir(trashRoot(), { recursive: true });
								await rm(trashPath, {
									recursive: true,
									force: true
								});
								await rename(originalPath, trashPath);
								artifactMoved = true;
								ctx.logger.debug(`[dsh-session-manager] moved ${id} artifact to trash`);
							}
							const entries = getEntries();
							const existingIndex = entries.findIndex((entry) => entry.sessionId === id);
							let next;
							let overflow = [];
							if (existingIndex >= 0) next = entries.map((entry, index) => index === existingIndex ? {
								...entry,
								deletedAt: Date.now()
							} : entry);
							else {
								next = [...entries, {
									sessionId: id,
									cwd: meta?.cwd,
									originalPath,
									deletedAt: Date.now()
								}];
								if (next.length > 10) {
									overflow = next.slice(0, next.length - 10);
									next = next.slice(next.length - 10);
								}
							}
							await setEntries(next);
							for (const entry of overflow) await rm(trashSessionDir(entry.sessionId), {
								recursive: true,
								force: true
							}).catch(() => {});
							respond(res, 200, { ok: true });
						} catch (error) {
							if (artifactMoved && originalPath !== void 0 && existsSync(trashPath) && !existsSync(originalPath)) try {
								await mkdir(dirname(originalPath), { recursive: true });
								await rename(trashPath, originalPath);
							} catch (rollbackError) {
								ctx.logger.warn(`[dsh-session-manager] artifact rollback failed for ${id}:`, rollbackError);
							}
							if (archiveStarted && !wasArchived) try {
								await unarchive(ctx, id);
							} catch (rollbackError) {
								ctx.logger.warn(`[dsh-session-manager] archive rollback failed for ${id}:`, rollbackError);
							}
							ctx.logger.warn(`[dsh-session-manager] ${failureCode} for ${id}:`, error);
							respond(res, 500, {
								ok: false,
								error: failureCode
							});
						}
					});
				} catch (error) {
					ctx.logger.warn("[dsh-session-manager] delete failed:", error);
					respond(res, 500, {
						ok: false,
						error: "delete-failed"
					});
				}
			}
		});
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/move`,
			handler: async (req, res) => {
				if (req.method !== "POST") return respond(res, 405, {
					ok: false,
					error: "method-not-allowed"
				});
				let body;
				try {
					body = await readJsonBody(req);
				} catch {
					return respond(res, 400, {
						ok: false,
						error: "bad-request"
					});
				}
				const id = parseSessionId(body);
				if (id === void 0) return respond(res, 400, {
					ok: false,
					error: "invalid-session-id"
				});
				const rawTarget = body?.targetCwd;
				if (typeof rawTarget !== "string" || rawTarget.trim().length === 0) return respond(res, 400, {
					ok: false,
					error: "invalid-target-cwd"
				});
				try {
					await withMutationLock(async () => {
						let realTarget;
						try {
							realTarget = await realpath(rawTarget);
							if (!existsSync(realTarget)) throw new Error("not a directory");
						} catch {
							respond(res, 400, {
								ok: false,
								error: "invalid-target-cwd"
							});
							return;
						}
						const meta = (await ctx.sessionPersistence.list()).find((header) => header.id === id);
						if (meta === void 0) {
							respond(res, 404, {
								ok: false,
								error: "not-found"
							});
							return;
						}
						if (ctx.agents.get(id)?.status === "running") {
							respond(res, 409, {
								ok: false,
								error: "session-live"
							});
							return;
						}
						let fromCwd = meta.cwd ?? "";
						if (fromCwd.length > 0) try {
							fromCwd = await realpath(fromCwd);
						} catch {}
						if (fromCwd === realTarget) {
							respond(res, 400, {
								ok: false,
								error: "same-workspace"
							});
							return;
						}
						const location = meta !== void 0 ? ctx.sessionPersistence.locate(meta) : void 0;
						if (location === void 0) {
							respond(res, 500, {
								ok: false,
								error: "no-artifact-location"
							});
							return;
						}
						let log;
						try {
							log = await readSessionLog(location.path);
						} catch (error) {
							ctx.logger.warn(`[dsh-session-manager] move ${id}: unreadable log:`, error);
							respond(res, 500, {
								ok: false,
								error: "bad-artifact"
							});
							return;
						}
						const newId = `session-${randomUUID()}`;
						const newMeta = {
							...log.header,
							id: newId,
							cwd: realTarget
						};
						const workspace = ctx.storageDomain.get("workspace");
						const wasArchived = workspace !== void 0 && workspace.global.get().archivedSessionIds.includes(id);
						const originalPath = dirname(location.path);
						const trashPath = trashSessionDir(id);
						let archivedOriginal = false;
						try {
							const agentPresetsSvc = ctx.get("agentPresets");
							let presetId;
							try {
								const resolved = await agentPresetsSvc?.resolve?.();
								if (resolved && typeof resolved === "object" && typeof resolved.id === "string") presetId = resolved.id;
							} catch {}
							const seededMeta = {
								...newMeta,
								...presetId !== void 0 ? { agentPreset: presetId } : {}
							};
							const agentsSvc = ctx.get("agents");
							let registeredViaAgents = false;
							if (typeof agentsSvc?.create === "function") try {
								await agentsSvc.create({
									sessionId: newId,
									meta: seededMeta,
									seed: log.events,
									setup: (agentCtx) => {
										const ap = ctx.get("agentPresets");
										return ap?.mount ? ap.mount(agentCtx, presetId).then(() => {}) : Promise.resolve();
									}
								});
								registeredViaAgents = true;
							} catch (agentsError) {
								ctx.logger.warn(`[dsh-session-manager] move ${id}: agents.create failed, falling back to persistence:`, agentsError);
							}
							if (!registeredViaAgents) {
								await ctx.sessionPersistence.create(seededMeta);
								if (log.events.length > 0) await ctx.sessionPersistence.append(newId, log.events);
							}
							try {
								const targetWorkspace = await ctx.workspaceRegistry.resolveByPath(realTarget);
								if (targetWorkspace !== void 0) await targetWorkspace.attachSession(newId);
							} catch (attachError) {
								ctx.logger.warn(`[dsh-session-manager] move ${id}: attaching to target workspace failed:`, attachError);
							}
							try {
								await ctx.workspaceRegistry.archiveSession(id);
								archivedOriginal = true;
								const currentWorkspace = ctx.storageDomain.get("workspace");
								if (currentWorkspace !== void 0) {
									const current = currentWorkspace.global.get();
									if (!current.archivedSessionIds.includes(id)) {
										const next = {
											...current,
											archivedSessionIds: [...current.archivedSessionIds, id]
										};
										await currentWorkspace.global.set(next);
										syncRegistryState(ctx, next);
									}
								}
							} catch (archiveError) {
								ctx.logger.warn(`[dsh-session-manager] move ${id}: archiving original failed:`, archiveError);
							}
							if (existsSync(originalPath)) {
								await mkdir(trashRoot(), { recursive: true });
								await rm(trashPath, {
									recursive: true,
									force: true
								});
								try {
									await rename(originalPath, trashPath);
								} catch (renameError) {
									if (renameError.code !== "EXDEV") throw renameError;
									cpSync(originalPath, trashPath, { recursive: true });
									await rm(originalPath, {
										recursive: true,
										force: true
									});
								}
							}
							const entries = getEntries();
							const existingIndex = entries.findIndex((entry) => entry.sessionId === id);
							let next;
							let overflow = [];
							if (existingIndex >= 0) next = entries.map((entry, index) => index === existingIndex ? {
								...entry,
								deletedAt: Date.now()
							} : entry);
							else {
								next = [...entries, {
									sessionId: id,
									cwd: meta.cwd,
									originalPath,
									deletedAt: Date.now()
								}];
								if (next.length > 10) {
									overflow = next.slice(0, next.length - 10);
									next = next.slice(next.length - 10);
								}
							}
							await setEntries(next);
							for (const entry of overflow) await rm(trashSessionDir(entry.sessionId), {
								recursive: true,
								force: true
							}).catch(() => {});
							ctx.logger.info(`[dsh-session-manager] moved ${id} -> ${newId} (${fromCwd} -> ${realTarget})${log.skippedLines > 0 ? `, ${log.skippedLines} unparsable line(s) dropped` : ""}`);
							respond(res, 200, {
								ok: true,
								newSessionId: newId,
								fromCwd,
								toCwd: realTarget
							});
						} catch (error) {
							if (existsSync(trashPath) && !existsSync(originalPath)) try {
								await mkdir(dirname(originalPath), { recursive: true });
								await rename(trashPath, originalPath);
							} catch (rollbackError) {
								ctx.logger.warn(`[dsh-session-manager] move ${id}: artifact rollback failed:`, rollbackError);
							}
							if (archivedOriginal && !wasArchived) try {
								await unarchive(ctx, id);
							} catch (rollbackError) {
								ctx.logger.warn(`[dsh-session-manager] move ${id}: unarchive rollback failed:`, rollbackError);
							}
							const detail = error instanceof Error ? error.message : String(error);
							ctx.logger.warn(`[dsh-session-manager] move ${id} partially failed:`, error);
							respond(res, 500, {
								ok: false,
								error: existsSync(trashPath) || archivedOriginal && !wasArchived ? "move-partial" : "move-failed",
								detail,
								newSessionId: newId
							});
						}
					});
				} catch (error) {
					ctx.logger.warn("[dsh-session-manager] move failed:", error);
					respond(res, 500, {
						ok: false,
						error: "move-failed"
					});
				}
			}
		});
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/restore`,
			handler: async (req, res) => {
				if (req.method !== "POST") return respond(res, 405, {
					ok: false,
					error: "method-not-allowed"
				});
				let body;
				try {
					body = await readJsonBody(req);
				} catch {
					return respond(res, 400, {
						ok: false,
						error: "bad-request"
					});
				}
				const id = parseSessionId(body);
				if (id === void 0) return respond(res, 400, {
					ok: false,
					error: "invalid-session-id"
				});
				try {
					await withMutationLock(async () => {
						const entries = getEntries();
						const entry = entries.find((candidate) => candidate.sessionId === id);
						if (entry === void 0) {
							const meta = (await ctx.sessionPersistence.list()).find((header) => header.id === id);
							const agent = ctx.agents.get(id);
							if (meta === void 0 && agent === void 0) return respond(res, 404, {
								ok: false,
								error: "trash-entry-not-found"
							});
							await unarchive(ctx, id);
							ctx.logger.debug(`[dsh-session-manager] restore ${id}: no trash entry, un-archived only`);
							return respond(res, 200, { ok: true });
						}
						const from = trashSessionDir(id);
						if (existsSync(from)) {
							if (entry.originalPath === void 0) {
								ctx.logger.warn(`[dsh-session-manager] restore ${id}: artifact exists in trash but entry has no original path`);
								return respond(res, 500, {
									ok: false,
									error: "no-original-path"
								});
							}
							if (existsSync(entry.originalPath)) {
								await rm(from, {
									recursive: true,
									force: true
								});
								ctx.logger.warn(`[dsh-session-manager] restore ${id}: original path already exists, discarding trash copy`);
							} else {
								await mkdir(dirname(entry.originalPath), { recursive: true });
								await rename(from, entry.originalPath);
								ctx.logger.debug(`[dsh-session-manager] restored ${id} artifact from trash`);
							}
						} else ctx.logger.debug(`[dsh-session-manager] restore ${id}: no artifact in trash (live or blank session)`);
						await unarchive(ctx, id);
						await setEntries(entries.filter((candidate) => candidate.sessionId !== id));
						respond(res, 200, { ok: true });
					});
				} catch (error) {
					ctx.logger.warn("[dsh-session-manager] restore failed:", error);
					respond(res, 500, {
						ok: false,
						error: "restore-failed"
					});
				}
			}
		});
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/purge`,
			handler: async (req, res) => {
				if (req.method !== "POST") return respond(res, 405, {
					ok: false,
					error: "method-not-allowed"
				});
				let body;
				try {
					body = await readJsonBody(req);
				} catch {
					return respond(res, 400, {
						ok: false,
						error: "bad-request"
					});
				}
				const id = parseSessionId(body);
				if (id === void 0) return respond(res, 400, {
					ok: false,
					error: "invalid-session-id"
				});
				try {
					await withMutationLock(async () => {
						const entries = getEntries();
						const entry = entries.find((candidate) => candidate.sessionId === id);
						if (entry === void 0) {
							respond(res, 404, {
								ok: false,
								error: "trash-entry-not-found"
							});
							return;
						}
						await rm(trashSessionDir(id), {
							recursive: true,
							force: true
						});
						if (entry.originalPath !== void 0) await rm(entry.originalPath, {
							recursive: true,
							force: true
						});
						await setEntries(entries.filter((candidate) => candidate.sessionId !== id));
						respond(res, 200, { ok: true });
					});
				} catch (error) {
					ctx.logger.warn("[dsh-session-manager] purge failed:", error);
					respond(res, 500, {
						ok: false,
						error: "purge-failed"
					});
				}
			}
		});
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/pause`,
			handler: async (req, res) => {
				if (req.method !== "POST") return respond(res, 405, {
					ok: false,
					error: "method-not-allowed"
				});
				let body;
				try {
					body = await readJsonBody(req);
				} catch {
					return respond(res, 400, {
						ok: false,
						error: "bad-request"
					});
				}
				const id = parseSessionId(body);
				if (id === void 0) return respond(res, 400, {
					ok: false,
					error: "invalid-session-id"
				});
				try {
					const agent = ctx.agents.get(id);
					if (agent === void 0) return respond(res, 404, {
						ok: false,
						error: "agent-not-found"
					});
					agent.cancel({ kind: "user" });
					respond(res, 200, { ok: true });
				} catch (error) {
					ctx.logger.warn("[dsh-session-manager] pause failed:", error);
					respond(res, 500, {
						ok: false,
						error: "pause-failed"
					});
				}
			}
		});
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/trash`,
			handler: async (_req, res) => {
				try {
					respond(res, 200, {
						ok: true,
						entries: getEntries(),
						limit: 10
					});
				} catch (error) {
					ctx.logger.warn("[dsh-session-manager] trash list failed:", error);
					respond(res, 500, {
						ok: false,
						error: "trash-list-failed"
					});
				}
			}
		});
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/compaction-threshold`,
			handler: async (req, res) => {
				if (req.method === "GET") {
					let ratio = configuredThreshold;
					if (ratio === null) try {
						const preset = await resolvePresetComposition(ctx, defaultPresetName(ctx));
						ratio = parsePresetRatio(await readFile(preset.path, "utf8")) ?? .8;
					} catch {
						ratio = .8;
					}
					respond(res, 200, {
						ok: true,
						ratio
					});
					return;
				}
				if (req.method !== "POST") return respond(res, 405, {
					ok: false,
					error: "method-not-allowed"
				});
				let body;
				try {
					body = await readJsonBody(req);
				} catch {
					return respond(res, 400, {
						ok: false,
						error: "bad-request"
					});
				}
				const ratio = body?.ratio;
				if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio < .17 || ratio > .9) return respond(res, 400, {
					ok: false,
					error: "invalid-ratio"
				});
				try {
					await withMutationLock(async () => {
						await setConfiguredThreshold(ratio);
						const preset = await resolvePresetComposition(ctx, defaultPresetName(ctx));
						if (preset.trust !== "system") await writePresetComposition(preset.path, ratio);
						await applyThresholdToLiveAgents(ctx, ratio);
						respond(res, 200, { ok: true });
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.logger.warn("[dsh-session-manager] compaction-threshold update failed:", error);
					respond(res, 500, {
						ok: false,
						error: message
					});
				}
			}
		});
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/open-folder`,
			handler: async (req, res) => {
				if (req.method !== "POST") return respond(res, 405, {
					ok: false,
					error: "method-not-allowed"
				});
				let body;
				try {
					body = await readJsonBody(req);
				} catch {
					return respond(res, 400, {
						ok: false,
						error: "bad-request"
					});
				}
				const id = parseSessionId(body);
				if (id === void 0) return respond(res, 400, {
					ok: false,
					error: "invalid-session-id"
				});
				try {
					let dir;
					const meta = (await ctx.sessionPersistence.list()).find((header) => header.id === id);
					if (meta !== void 0) {
						const location = ctx.sessionPersistence.locate(meta);
						if (location !== void 0) dir = dirname(location.path);
					}
					if (dir === void 0 || !existsSync(dir)) {
						const entry = getEntries().find((candidate) => candidate.sessionId === id);
						if (entry?.originalPath !== void 0 && existsSync(entry.originalPath)) dir = entry.originalPath;
					}
					if (dir === void 0 || !existsSync(dir)) return respond(res, 404, {
						ok: false,
						error: "folder-not-found"
					});
					await openFolder(dir);
					respond(res, 200, { ok: true });
				} catch (error) {
					ctx.logger.warn("[dsh-session-manager] open-folder failed:", error);
					respond(res, 500, {
						ok: false,
						error: "open-folder-failed"
					});
				}
			}
		});
		return () => trash.close();
	});
}
//#endregion
export { TRASH_LIMIT, apply, inject, name, openFolderCommand, readSessionLog };
