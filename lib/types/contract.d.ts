/**
 * Wire contract shared by the host routes and the web client panel.
 * Both halves only exchange JSON, so the contract is types plus route
 * constants — no runtime import crosses the boundary.
 */
/** The host route the client panel calls to delete (move to trash) one session. */
export declare const DELETE_ROUTE = "/dsh-session-manager/delete";
/** Restore one session from the trash back to its original location. */
export declare const RESTORE_ROUTE = "/dsh-session-manager/restore";
/** Permanently purge one session from the trash. */
export declare const PURGE_ROUTE = "/dsh-session-manager/purge";
/** List the current trash contents. */
export declare const TRASH_ROUTE = "/dsh-session-manager/trash";
/** Reveal a session's log directory in the system file manager. */
export declare const OPEN_FOLDER_ROUTE = "/dsh-session-manager/open-folder";
/** Stop a running session's current turn (pause). */
export declare const PAUSE_ROUTE = "/dsh-session-manager/pause";
/** Write the context compaction threshold into the official compaction plugin config. */
export declare const COMPACTION_THRESHOLD_ROUTE = "/dsh-session-manager/compaction-threshold";
/** Move one session to a different workspace directory (re-groups it in the UI). */
export declare const MOVE_ROUTE = "/dsh-session-manager/move";
/** Browse one host directory so the panel can hand out `@path` references. */
export declare const LIST_DIR_ROUTE = "/dsh-session-manager/list-dir";
/** POST /dsh-session-manager/delete request body. */
export interface DeleteSessionRequest {
    sessionId: string;
}
/** POST /dsh-session-manager/restore and /purge request body. */
export interface TrashActionRequest {
    sessionId: string;
}
/** One trash entry (host-side record, mirrored to the client). */
export interface TrashEntry {
    sessionId: string;
    /** Working directory at delete time, when the session had one. */
    cwd?: string;
    /** Original on-disk artifact directory, restored into on restore. */
    originalPath?: string;
    /** Epoch ms when the session was moved to the trash. */
    deletedAt: number;
}
/** POST delete/restore/purge response body. */
export interface ActionResultResponse {
    ok: boolean;
    /** Machine-readable failure reason. */
    error?: string;
}
/** GET /dsh-session-manager/trash response body. */
export interface TrashListResponse {
    ok: boolean;
    entries: TrashEntry[];
    /** Maximum entries kept; the oldest overflow is purged automatically. */
    limit: number;
}
/** POST /dsh-session-manager/list-dir request body. */
export interface DirListRequest {
    /** Absolute host directory to list (usually a workspace path). */
    path: string;
}
/** One entry of a listed directory. */
export interface DirEntry {
    name: string;
    type: 'directory' | 'file';
    /** Byte size; files only. */
    size?: number;
    /** Epoch ms of the last modification, when stat succeeded. */
    mtime?: number;
}
/** POST /dsh-session-manager/list-dir response body. */
export interface DirListResponse {
    ok: boolean;
    /** The canonical directory actually listed. */
    path?: string;
    /** Directories first, then files, each group name-sorted. */
    entries?: DirEntry[];
    error?: string;
}
/** POST /dsh-session-manager/move request body. */
export interface MoveSessionRequest {
    sessionId: string;
    /** Target directory (canonical on the host); the session re-groups under the matching workspace. */
    targetCwd: string;
}
/** POST /dsh-session-manager/move response body. */
export interface MoveSessionResponse {
    ok: boolean;
    /** Machine-readable failure reason. */
    error?: string;
    /** Underlying failure message (diagnostics; shown by the client). */
    detail?: string;
    /**
     * Set when `ok` is true but a post-move cleanup step failed (e.g. the
     * original artifact could not be moved into the trash). The move itself
     * landed; the client may surface this as a soft notice.
     */
    warning?: string;
    /** The re-created session id (the move rebuilds the log under a fresh id). */
    newSessionId?: string;
    fromCwd?: string;
    toCwd?: string;
}
//# sourceMappingURL=contract.d.ts.map