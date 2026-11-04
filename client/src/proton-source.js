// Optional bridge: expose this mesh as one workspace source for
// dsh-proton-workspace. Deliberately dependency-free — the proton side is
// discovered at runtime through the protonWorkspace service, so this bundle
// never imports proton code and keeps working when proton is absent.

var STATE_PATH = "/api/mesh/state";
var ANCHOR_PATH = "/api/mesh/anchor";
var ANCHORS_PATH = "/api/mesh/anchors";

function readJson(response) {
  return response.text().then(function (text) {
    var value;
    try {
      value = text ? JSON.parse(text) : undefined;
    } catch (error) {
      value = undefined;
    }
    if (!response.ok) {
      var message = value && typeof value === "object" && "error" in value
        ? String(value.error)
        : "HTTP " + response.status;
      throw new Error(message);
    }
    return value;
  });
}

function request(fetcher, path, init) {
  var base = { credentials: "same-origin", headers: { accept: "application/json" } };
  if (init && init.body !== undefined) base.headers["content-type"] = "application/json";
  return fetcher(path, Object.assign(base, init)).then(readJson);
}

/** Split the mesh's "nodeId/workspaceId" candidate id back into its two halves. */
function splitTarget(id) {
  var slash = String(id).indexOf("/");
  if (slash <= 0 || slash === String(id).length - 1) {
    throw new Error('malformed mesh workspace id "' + id + '"');
  }
  return { nodeId: id.slice(0, slash), workspaceId: id.slice(slash + 1) };
}

/** Identity of one directory across the two spellings the host can report. */
function pathKey(path) {
  return String(path).replace(/[\\/]+$/, "").toLowerCase();
}

/**
 * One workspace source over this mesh's own three routes: peers' workspaces come
 * from the read-only state snapshot, adopting one asks the host to create the
 * local anchor and the native workspace record behind it, and the anchor listing
 * says which directory belongs to which machine.
 *
 * The listing exists because a row asks "where does this directory live" while
 * rendering, and the answer arrives after the first paint. So the cache is
 * filled lazily, cleared when an adopt changes it, and announced to whoever
 * subscribed — the row that asked early is told to ask again.
 */
export function createMeshWorkspaceSource(fetcher) {
  var call = fetcher || (typeof fetch === "function" ? fetch.bind(globalThis) : undefined);

  /** pathKey -> anchor record, or undefined while nothing has been loaded. */
  var anchors;
  var loading;
  var listeners = [];

  function requireFetcher() {
    if (typeof call !== "function") throw new Error("mesh workspace source has no fetch implementation");
    return call;
  }

  function notify() {
    var pending = listeners.slice();
    for (var i = 0; i < pending.length; i += 1) pending[i]();
  }

  function forget() {
    anchors = undefined;
    loading = undefined;
  }

  function load() {
    if (loading !== undefined) return loading;
    loading = request(requireFetcher(), ANCHORS_PATH).then(function (payload) {
      var map = new Map();
      var rows = (payload && payload.anchors) || [];
      for (var i = 0; i < rows.length; i += 1) {
        var row = rows[i];
        if (!row || typeof row.path !== "string") continue;
        map.set(pathKey(row.path), row);
      }
      anchors = map;
      loading = undefined;
      notify();
      return map;
    }).catch(function () {
      // A listing failure must not break the sidebar: the rows stay unmarked and
      // the next render tries again.
      loading = undefined;
      return undefined;
    });
    return loading;
  }

  return {
    id: "mesh",
    label: "工作区网格",
    list: function () {
      return request(requireFetcher(), STATE_PATH).then(function (payload) {
        var rows = [];
        var peers = (payload && payload.peers) || [];
        for (var i = 0; i < peers.length; i += 1) {
          var peer = peers[i];
          var workspaces = peer.workspaces || [];
          for (var j = 0; j < workspaces.length; j += 1) {
            var workspace = workspaces[j];
            rows.push({
              id: peer.nodeId + "/" + workspace.workspaceId,
              title: (workspace.name || workspace.workspaceId) + " @" + (peer.label || peer.nodeId),
              detail: workspace.path,
              status: peer.status || "unknown"
            });
          }
        }
        return rows;
      });
    },
    adopt: function (id) {
      var target = splitTarget(id);
      return request(requireFetcher(), ANCHOR_PATH, {
        method: "POST",
        body: JSON.stringify(target)
      }).then(function (payload) {
        // A new anchor is exactly the change this cache exists to report.
        forget();
        load();
        return { path: payload.workspace.path };
      });
    },
    /**
     * Where the workspace at `path` actually lives. Synchronous by contract:
     * rows call this while rendering, so the first call starts the listing and
     * answers "nothing yet" rather than blocking.
     */
    describe: function (path) {
      if (typeof path !== "string" || path === "") return undefined;
      if (anchors === undefined) {
        load();
        return undefined;
      }
      var record = anchors.get(pathKey(path));
      if (record === undefined) return undefined;
      return {
        machine: record.nodeLabel || record.nodeId,
        remotePath: record.remoteCwd
      };
    },
    subscribe: function (listener) {
      listeners.push(listener);
      return function () {
        var index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    }
  };
}
