[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$CodexHome,
    [string]$ResolveThreadId
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# The Node bridge decodes redirected JSON output as UTF-8.
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

if ($CodexHome.IndexOf([char]0) -ge 0) {
    throw 'Codex home contains an invalid character.'
}

$resolvedHome = [System.IO.Path]::GetFullPath($CodexHome).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
if (-not (Test-Path -LiteralPath $resolvedHome -PathType Container)) {
    throw 'Codex home does not exist.'
}

$databasePath = [System.IO.Path]::GetFullPath((Join-Path -Path $resolvedHome -ChildPath 'state_5.sqlite'))
$expectedPrefix = $resolvedHome + [System.IO.Path]::DirectorySeparatorChar
if (-not $databasePath.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $databasePath -PathType Leaf)) {
    throw 'Codex state database is unavailable.'
}

$nativeCode = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public sealed class CodexTaskListRow {
    public long title_matches;
    public string id;
    public string title;
    public long recency_at_ms;
    public long updated_at_ms;
    public long is_pinned;
    public long archived;
    public long? position;
    public string projectId;
}

public static class CodexTaskListSqlite {
    private const int SQLITE_OK = 0;
    private const int SQLITE_ROW = 100;
    private const int SQLITE_DONE = 101;
    private const int SQLITE_NULL = 5;
    private const int SQLITE_OPEN_READONLY = 0x00000001;

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_open_v2(byte[] filename, out IntPtr database, int flags, IntPtr vfs);

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_close_v2(IntPtr database);

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_prepare_v2(IntPtr database, byte[] sql, int sqlBytes, out IntPtr statement, IntPtr tail);

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_step(IntPtr statement);

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_finalize(IntPtr statement);

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr sqlite3_errmsg(IntPtr database);

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr sqlite3_column_text(IntPtr statement, int column);

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_column_bytes(IntPtr statement, int column);

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern long sqlite3_column_int64(IntPtr statement, int column);

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_column_type(IntPtr statement, int column);

    private static byte[] Utf8Z(string value) {
        return Encoding.UTF8.GetBytes(value + "\0");
    }

    private static string ColumnText(IntPtr statement, int column) {
        if (sqlite3_column_type(statement, column) == SQLITE_NULL) return null;
        IntPtr pointer = sqlite3_column_text(statement, column);
        int length = sqlite3_column_bytes(statement, column);
        if (pointer == IntPtr.Zero || length <= 0) return String.Empty;
        byte[] bytes = new byte[length];
        Marshal.Copy(pointer, bytes, 0, length);
        return Encoding.UTF8.GetString(bytes);
    }

    private static string ErrorMessage(IntPtr database, string operation, int code) {
        IntPtr pointer = database == IntPtr.Zero ? IntPtr.Zero : sqlite3_errmsg(database);
        string message = pointer == IntPtr.Zero ? "unknown sqlite error" : Marshal.PtrToStringAnsi(pointer);
        return operation + " failed (" + code + "): " + message;
    }

    public static List<CodexTaskListRow> ReadRows(string databasePath, string resolveThreadId) {
        IntPtr database = IntPtr.Zero;
        IntPtr statement = IntPtr.Zero;
        int result = sqlite3_open_v2(Utf8Z(databasePath), out database, SQLITE_OPEN_READONLY, IntPtr.Zero);
        if (result != SQLITE_OK) {
            string message = ErrorMessage(database, "open readonly", result);
            if (database != IntPtr.Zero) sqlite3_close_v2(database);
            throw new InvalidOperationException(message);
        }
        try {
            // Codex displays name; title can still contain the initial user message.
            // The desktop Micro recent list orders visible tasks by updatedAt.
            // Filter internal threads and archived tasks before the row limit so
            // background workers cannot occupy (or crowd out) the six slots.
            // Legacy user tasks may not have thread_source populated yet.
            string query = "SELECT substr(id, 1, 128), substr(COALESCE(NULLIF(name, ''), title), 1, 160), recency_at_ms, is_pinned, archived, section_position, substr(project_id, 1, 128), COALESCE(updated_at_ms, updated_at * 1000) AS micro_updated_at_ms FROM threads WHERE id IS NOT NULL AND archived = 0 AND COALESCE(thread_source, 'user') = 'user' AND COALESCE(source, '') NOT LIKE '%\"subagent\"%' ORDER BY micro_updated_at_ms DESC, id ASC LIMIT 256";
            if (!String.IsNullOrEmpty(resolveThreadId)) {
                if (!System.Text.RegularExpressions.Regex.IsMatch(resolveThreadId, @"\A[a-zA-Z0-9_-]{1,128}\z")) throw new ArgumentException("Invalid task ID.");
                query = "SELECT t.id, COALESCE(NULLIF(t.name, ''), t.title), 0, (SELECT COUNT(*) FROM threads x WHERE x.archived=0 AND COALESCE(NULLIF(x.name, ''), x.title)=COALESCE(NULLIF(t.name, ''), t.title)), t.archived, NULL, t.project_id, 0 FROM threads t WHERE t.archived=0 AND t.id='" + resolveThreadId + "'";
            }
            result = sqlite3_prepare_v2(database, Utf8Z(query), -1, out statement, IntPtr.Zero);
            if (result != SQLITE_OK) throw new InvalidOperationException(ErrorMessage(database, "prepare", result));
            List<CodexTaskListRow> rows = new List<CodexTaskListRow>();
            while ((result = sqlite3_step(statement)) == SQLITE_ROW) {
                rows.Add(new CodexTaskListRow {
                    id = ColumnText(statement, 0),
                    title = ColumnText(statement, 1),
                    recency_at_ms = sqlite3_column_int64(statement, 2),
                    updated_at_ms = sqlite3_column_int64(statement, 7),
                    is_pinned = String.IsNullOrEmpty(resolveThreadId) ? sqlite3_column_int64(statement, 3) : 0,
                    title_matches = String.IsNullOrEmpty(resolveThreadId) ? 0 : sqlite3_column_int64(statement, 3),
                    archived = sqlite3_column_int64(statement, 4),
                    position = sqlite3_column_type(statement, 5) == SQLITE_NULL ? (long?)null : sqlite3_column_int64(statement, 5),
                    projectId = ColumnText(statement, 6)
                });
            }
            if (result != SQLITE_DONE) throw new InvalidOperationException(ErrorMessage(database, "step", result));
            return rows;
        } finally {
            if (statement != IntPtr.Zero) sqlite3_finalize(statement);
            if (database != IntPtr.Zero) sqlite3_close_v2(database);
        }
    }
}
'@

try {
    if (-not ('CodexTaskListSqlite' -as [type])) {
        Add-Type -TypeDefinition $nativeCode -Language CSharp -ErrorAction Stop
    }
    $rows = [CodexTaskListSqlite]::ReadRows($databasePath, $ResolveThreadId)
    [pscustomobject]@{
        schemaVersion = 1
        rows = @($rows)
    } | ConvertTo-Json -Compress -Depth 3
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
