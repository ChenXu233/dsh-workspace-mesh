// Browser half of the workspace mesh: converted from the hand-written
// single-file bundle so the topology can carry a real interactive canvas.
// scripts/build-client.mjs wraps this module back into the
// window.__ModuleLoader__.load({ id, factory }) shape the host expects.
import * as React from "react";
import * as jsx from "react/jsx-runtime";
import { MeshTopology, TOPOLOGY_CSS, TopoBoundary, ensureVendorCss } from "./topology.jsx";
import { createMeshWorkspaceSource } from "./proton-source.js";
    // The settings namespace equals this bundle's profile entry id (cordis.patch.yml: id: mesh).
    var NS = "mesh";
    // Read-only snapshot served by the host half (src/api/index.ts).
    var STATE_PATH = "/api/mesh/state";
    // Config writes land in the plugin's own override file (src/api/config.ts).
    var CONFIG_PATH = "/api/mesh/config";
    // Browser-triggered dispatch: same code path as the mesh_dispatch tool (src/api/dispatch.ts).
    var DISPATCH_PATH = "/api/mesh/dispatch";
    // Remote session history: the peer is the only authority, this route proxies.
    var SESSION_PATH = "/api/mesh/session";

    var FIELDS = [
      { key: "transport", label: "传输模式", kind: "select", options: ["auto"],
        hint: "配了 peers 时走 typert；保存后重启生效" },
      { key: "assignmentFile", label: "assignment.yml 路径", kind: "text",
        hint: "相对宿主进程 cwd（容器内为 /data/workspace）；留空 = 不加载" },
      { key: "leaseMs", label: "任务租约时长 (ms)", kind: "number", hint: "默认 900000" },
      { key: "dispatchTimeoutMs", label: "dispatch 超时 (ms)", kind: "number", hint: "默认 120000" },
      { key: "leaseOwner", label: "租约归属者", kind: "text", hint: "默认 mesh-lead" }
    ];

    /** Settings-page form: same five fields, saved through POST /api/mesh/config. */
    var CONFIG_FIELDS = [
      { key: "transport", label: "传输模式", kind: "select", options: ["auto"],
        hint: "配了 peers 时走 typert；修改后重启容器生效" },
      { key: "assignmentFile", label: "assignment.yml 路径", kind: "text",
        hint: "相对宿主进程 cwd（容器内 /data/workspace）；保存即热加载" },
      { key: "leaseMs", label: "租约时长 (ms)", kind: "number", hint: "保存后立即生效" },
      { key: "dispatchTimeoutMs", label: "dispatch 超时 (ms)", kind: "number", hint: "保存后立即生效" },
      { key: "leaseOwner", label: "租约归属者", kind: "text", hint: "保存后立即生效" }
    ];

    var css = ".dwm-section{max-width:760px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex}" +
      ".dwm-row{flex-direction:column;gap:4px;display:flex}" +
      ".dwm-label{font-size:13px;font-weight:600}" +
      ".dwm-hint{color:var(--dsw-alias-label-tertiary);font-size:12px}" +
      ".dwm-input,.dwm-select{background:var(--dsw-alias-bg-input,var(--dsw-alias-bg-secondary));border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:inherit;font:inherit;padding:6px 10px;width:100%;box-sizing:border-box}" +
      ".dwm-input:focus,.dwm-select:focus{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}" +
      ".dwm-actions{gap:8px;align-items:center;display:flex}" +
      ".dwm-btn{background:var(--dsw-alias-state-business-primary);border:0;border-radius:6px;color:#fff;cursor:pointer;font:inherit;padding:6px 16px}" +
      ".dwm-btn:disabled{opacity:.5;cursor:default}" +
      ".dwm-status{font-size:12px;margin:0}" +
      ".dwm-status[data-tone=ok]{color:var(--dsw-alias-state-success,var(--dsw-alias-label-secondary))}" +
      ".dwm-status[data-tone=err]{color:var(--dsw-alias-state-danger,var(--dsw-alias-state-business-primary))}" +
      ".dwm-status[data-tone=warn]{color:var(--dsw-alias-label-tertiary)}" +
      ".dwm-page{max-width:760px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:14px;display:flex}" +
      ".dwm-h2{margin:0;font-size:18px;font-weight:600;line-height:26px}" +
      ".dwm-h3{margin:2px 0 0;font-size:15px;font-weight:600;line-height:22px}" +
      ".dwm-intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px;line-height:20px}" +
      ".dwm-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(118px,1fr));gap:10px}" +
      ".dwm-stat{border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:9px 12px;display:flex;flex-direction:column;gap:2px;min-width:0}" +
      ".dwm-statLabel{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:16px}" +
      ".dwm-statValue{font-size:16px;font-weight:600;line-height:22px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".dwm-statHint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".dwm-table{width:100%;border-collapse:collapse;font-size:13px}" +
      ".dwm-table th{color:var(--dsw-alias-label-tertiary);font-weight:500;text-align:left;padding:6px 8px;border-bottom:.5px solid var(--dsw-alias-border-l2);font-size:12px;white-space:nowrap}" +
      ".dwm-table td{padding:7px 8px;border-bottom:.5px solid var(--dsw-alias-border-l1,var(--dsw-alias-border-l2));vertical-align:middle}" +
      ".dwm-table tr:last-child td{border-bottom:0}" +
      ".dwm-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}" +
      ".dwm-badge{display:inline-flex;align-items:center;gap:4px;border-radius:999px;padding:1px 8px;font-size:11px;line-height:16px;border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);white-space:nowrap}" +
      ".dwm-badge[data-tone=ok]{color:var(--dsw-alias-state-success,var(--dsw-alias-label-secondary));border-color:currentColor}" +
      ".dwm-badge[data-tone=err]{color:var(--dsw-alias-state-danger,var(--dsw-alias-state-business-primary));border-color:currentColor}" +
      ".dwm-badge[data-tone=warn]{color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l2)}" +
      ".dwm-note{color:var(--dsw-alias-label-tertiary);font-size:12px;margin:0;line-height:18px}" +
      ".dwm-note[data-tone=warn]{color:var(--dsw-alias-label-secondary)}" +
      ".dwm-footer{display:flex;align-items:center;gap:10px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}" +
      ".dwm-ghost{background:0 0;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;padding:4px 10px}" +
      ".dwm-ghost:disabled{opacity:.5;cursor:default}" +
      ".dwm-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;margin:0}" +
      ".dwm-form{display:flex;flex-direction:column;gap:10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:12px}" +
      ".dwm-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px}" +
      ".dwm-field{display:flex;flex-direction:column;gap:4px;min-width:0}" +
      ".dwm-topo{width:100%;height:auto;display:block;color:var(--dsw-alias-label-primary)}" +
      ".dwm-topo text{fill:var(--dsw-alias-label-primary)}" +
      ".dwm-topo text[fontSize=\"10\"],.dwm-topo text[opacity=\"0.7\"]{fill:var(--dsw-alias-label-tertiary)}" +
      TOPOLOGY_CSS;
    ensureVendorCss();
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css='dsh-workspace-mesh/config']") === null) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-workspace-mesh";
      tag.dataset.pluginCss = "dsh-workspace-mesh/config";
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    /** Required services (cordis fiber inject on the browser half). */
    var inject = ["slots", "remote", "remote.settings"];

    function prefersChinese() {
      if (typeof document !== "undefined" && document.documentElement && document.documentElement.lang) {
        return /^zh/i.test(document.documentElement.lang);
      }
      if (typeof navigator !== "undefined" && navigator.language) return /^zh/i.test(navigator.language);
      return true;
    }
    function t(zh, en) { return prefersChinese() ? zh : en; }

    /** The plugin detail page configuration card (kept from the first increment). */
    function ConfigSection(props) {
      var ctx = props.ctx;
      var subject = props.subject;
      var pkgName = subject && subject.pkg && typeof subject.pkg === "object" ? subject.pkg.name : subject.pkg;
      // The detail page re-renders this slot once without a subject; keep
      // rendering our section there and only hide on a DIFFERENT bundle.
      if (subject) {
        if (subject.kind !== "bundle" || pkgName !== "dsh-workspace-mesh") return null;
      }
      var st = React.useState({ phase: "loading", values: {}, revision: undefined, dirty: {}, message: "", tone: "warn" });
      var state = st[0], set = st[1];
      var load = React.useCallback(function () {
        if (!ctx.remote || !ctx.remote.settings) {
          set({ phase: "error", values: {}, revision: undefined, dirty: {}, message: "ctx.remote.settings 不可用", tone: "err" });
          return;
        }
        ctx.remote.settings.describe().then(function (doc) {
          var nsList = (doc && doc.namespaces) || [];
          var ns = null;
          for (var i = 0; i < nsList.length; i++) if (nsList[i].ns === NS) ns = nsList[i];
          if (!ns) { set({ phase: "missing", values: {}, revision: undefined, dirty: {}, message: "namespaces=[" + nsList.map(function (n) { return n.ns; }).join(",") + "]", tone: "warn" }); return; }
          set({ phase: "ready", values: ns.value || {}, revision: ns.revision, dirty: {}, message: "", tone: "warn" });
        }).catch(function (err) {
          set({ phase: "error", values: {}, revision: undefined, dirty: {}, message: String((err && err.message) || err), tone: "err" });
        });
      }, [ctx]);
      React.useEffect(function () { load(); }, [load]);
      if (state.phase === "loading") return jsx.jsx("p", { className: "dwm-status", "data-tone": "warn", children: "正在读取 mesh 配置…" });
      if (state.phase === "missing") return jsx.jsx("p", { className: "dwm-status", "data-tone": "warn", children: "设置服务未暴露 mesh 命名空间 " + (state.message || "") });
      if (state.phase === "error") return jsx.jsxs("p", { className: "dwm-status", "data-tone": "err", children: ["读取失败：", state.message] });
      var dirtyKeys = Object.keys(state.dirty);
      function setDirty(key, value) {
        set(function (s) { var d = Object.assign({}, s.dirty); d[key] = value; return Object.assign({}, s, { dirty: d }); });
      }
      function onSave() {
        var ops = [];
        for (var i = 0; i < dirtyKeys.length; i++) {
          var key = dirtyKeys[i];
          var field = null;
          for (var j = 0; j < FIELDS.length; j++) if (FIELDS[j].key === key) field = FIELDS[j];
          var value = state.dirty[key];
          if (field && field.kind === "number") value = Number(value);
          ops.push({ op: "set", path: [key], value: value });
        }
        set(function (s) { return Object.assign({}, s, { message: "保存中…", tone: "warn" }); });
        ctx.remote.settings.mutate(NS, ops, state.revision).then(function () {
          set(function (s) { return Object.assign({}, s, { message: "已保存并实时生效", tone: "ok", dirty: {} }); });
          load();
        }).catch(function (err) {
          set(function (s) { return Object.assign({}, s, { message: "保存失败：" + String((err && err.message) || err), tone: "err" }); });
        });
      }
      var rows = [];
      for (var k = 0; k < FIELDS.length; k++) {
        (function (f) {
          var current = state.dirty[f.key] !== undefined ? state.dirty[f.key] : (state.values[f.key] === undefined ? "" : String(state.values[f.key]));
          var control;
          if (f.kind === "select") {
            var opts = [];
            for (var m = 0; m < f.options.length; m++) opts.push(jsx.jsx("option", { value: f.options[m], children: f.options[m] }, f.options[m]));
            control = jsx.jsx("select", { className: "dwm-select", value: current, onChange: function (e) { setDirty(f.key, e.target.value); }, children: opts });
          } else {
            control = jsx.jsx("input", { className: "dwm-input", type: f.kind === "number" ? "number" : "text", value: current, onChange: function (e) { setDirty(f.key, e.target.value); } });
          }
          rows.push(jsx.jsxs("label", { className: "dwm-row", children: [
            jsx.jsx("span", { className: "dwm-label", children: f.label }),
            control,
            jsx.jsx("span", { className: "dwm-hint", children: f.hint })
          ], key: f.key }));
        })(FIELDS[k]);
      }
      return jsx.jsxs("div", { className: "dwm-section", children: [
        jsx.jsx("h3", { style: { margin: "0", fontSize: "15px", fontWeight: "600" }, children: "mesh 配置" }),
        jsx.jsx("p", { className: "dwm-status", "data-tone": "warn", children: "修改通过原生设置服务实时生效（volatile live 配置，写入 profile patch）" }),
        rows,
        jsx.jsxs("div", { className: "dwm-actions", children: [
          jsx.jsx("button", { className: "dwm-btn", disabled: dirtyKeys.length === 0 || state.message === "保存中…", onClick: onSave, children: "保存" }),
          state.message ? jsx.jsx("span", { className: "dwm-status", "data-tone": state.tone, children: state.message }) : null
        ] })
      ] });
    }

    function pad(value) { return value < 10 ? "0" + value : String(value); }
    function fmtClock(ms) {
      var date = new Date(ms);
      return pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
    }
    function fmtAgo(ms, now) {
      if (!ms) return "—";
      var diff = Math.max(0, now - ms);
      if (diff < 60000) return Math.floor(diff / 1000) + " 秒前";
      if (diff < 3600000) return Math.floor(diff / 60000) + " 分钟前";
      if (diff < 86400000) return Math.floor(diff / 3600000) + " 小时前";
      return Math.floor(diff / 86400000) + " 天前";
    }
    function peerTone(status) {
      if (status === "online") return "ok";
      if (status === "offline") return "err";
      return "muted";
    }
    function taskTone(state) {
      if (state === "done") return "ok";
      if (state === "failed" || state === "expired") return "err";
      if (state === "running" || state === "dispatched") return "warn";
      return "muted";
    }
    function stateText(state) {
      var map = { queued: "排队", dispatched: "已派发", running: "运行中", done: "完成", failed: "失败", expired: "过期" };
      return map[state] || state;
    }
    function sourceText(source) {
      if (source === "assignment") return "assignment.yml";
      if (source === "transport") return "传输回执";
      return "两者";
    }

    function Stat(props) {
      return jsx.jsxs("div", { className: "dwm-stat", children: [
        jsx.jsx("span", { className: "dwm-statLabel", children: props.label }),
        jsx.jsx("span", { className: "dwm-statValue", children: props.value }),
        props.hint ? jsx.jsx("span", { className: "dwm-statHint", title: props.hint, children: props.hint }) : null
      ] });
    }

    function Badge(props) {
      return jsx.jsx("span", { className: "dwm-badge", "data-tone": props.tone || "muted", children: props.children });
    }


    /**
     * One row per (server, workspace): "this workspace lives on that machine".
     * assignment.yml routes and transport receipts are merged, so a workspace
     * declared and confirmed shows up once with source "both" — never twice.
     */
    function workspaceRows(peers) {
      var rows = [];
      var byKey = {};
      for (var i = 0; i < peers.length; i += 1) {
        var peer = peers[i];
        var add = function (workspaceId, label, path, source, sessions) {
          var key = peer.nodeId + "/" + workspaceId;
          var row = byKey[key];
          if (row) {
            if (row.source !== source) row.source = "both";
            if (!row.label && label) row.label = label;
            if (!row.path && path) row.path = path;
            if (sessions && sessions.length > 0 && row.sessions.length === 0) row.sessions = sessions;
            return;
          }
          row = {
            workspaceId: workspaceId,
            nodeId: peer.nodeId,
            nodeLabel: peer.label || "",
            endpoint: peer.endpoint || "",
            status: peer.status || "unknown",
            label: label || "",
            path: path || "",
            source: source,
            sessions: sessions || []
          };
          byKey[key] = row;
          rows.push(row);
        };
        var assigned = peer.assignedWorkspaceIds || [];
        for (var a = 0; a < assigned.length; a += 1) add(assigned[a], "", "", "assignment", []);
        var known = peer.workspaces || [];
        for (var w = 0; w < known.length; w += 1) {
          add(known[w].workspaceId, known[w].name || "", known[w].path || "", "transport", known[w].sessionList || []);
        }
      }
      return rows;
    }

    /**
     * Send one message to a workspace that lives on another machine.
     *
     * A remote workspace is virtual here: nothing is copied, the page only knows
     * its id, owner and status. Sending posts to /api/mesh/dispatch, which runs
     * the same code as the mesh_dispatch tool — the agent loop stays on the
     * owning machine and only the final text comes back.
     */
    function RemoteWorkspacePanel(props) {
      var rows = props.rows;
      var online = rows.filter(function (row) { return row.status === "online"; });
      var options = online.length > 0 ? online : rows;
      var selState = React.useState("");
      var selected = selState[0];
      var setSelected = selState[1];
      var sessState = React.useState("");
      var sessionId = sessState[0];
      var setSessionId = sessState[1];
      var textState = React.useState("");
      var text = textState[0];
      var setText = textState[1];
      var sendState = React.useState({ phase: "idle", tone: "", message: "", summary: "", code: "" });
      var send = sendState[0];
      var setSend = sendState[1];

      React.useEffect(function () {
        if (selected !== "") return;
        if (options.length === 0) return;
        setSelected(options[0].nodeId + "/" + options[0].workspaceId);
      }, [selected, options]);
      // Switching workspace switches its session list: start on "new session".
      React.useEffect(function () { setSessionId(""); }, [selected]);

      var current = null;
      for (var ci = 0; ci < options.length; ci += 1) {
        if (options[ci].nodeId + "/" + options[ci].workspaceId === selected) current = options[ci];
      }
      var sessions = (current && current.sessions) || [];
      var histState = React.useState({ phase: "idle", messages: [], error: "" });
      var history = histState[0];
      var setHistory = histState[1];

      React.useEffect(function () {
        if (sessionId === "") {
          setHistory({ phase: "idle", messages: [], error: "" });
          return;
        }
        var nodeId = current ? current.nodeId : "";
        if (nodeId === "") return;
        setHistory({ phase: "loading", messages: [], error: "" });
        fetch(SESSION_PATH + "?nodeId=" + encodeURIComponent(nodeId) + "&sessionId=" + encodeURIComponent(sessionId) + "&limit=50",
          { credentials: "same-origin", headers: { accept: "application/json" } })
          .then(function (response) { return response.json(); })
          .then(function (data) {
            if (data && data.ok === true) setHistory({ phase: "ready", messages: data.messages || [], error: "" });
            else setHistory({ phase: "error", messages: [], error: String((data && (data.code || data.error)) || "read failed") });
          })
          .catch(function (error) { setHistory({ phase: "error", messages: [], error: String((error && error.message) || error) }); });
      }, [sessionId, selected]);

      if (rows.length === 0) {
        return jsx.jsxs("div", { className: "dwm-form", children: [
          jsx.jsx("h3", { className: "dwm-h3", children: t("远程工作区", "Remote workspaces") }),
          jsx.jsx("p", { className: "dwm-empty", children: t("还没有远端工作区：配置 assignment.yml 与 peers 后出现。", "No remote workspaces yet: add assignment.yml and peers.") })
        ] });
      }

      var sending = send.phase === "sending";
      var disabled = sending || selected === "" || text.trim() === "";
      function submit() {
        var row = null;
        for (var i = 0; i < options.length; i += 1) {
          if (options[i].nodeId + "/" + options[i].workspaceId === selected) row = options[i];
        }
        if (row === null) return;
        setSend({ phase: "sending", tone: "", message: t("已投递，等待远端回复…", "Dispatched, waiting for the remote reply…"), summary: "", code: "" });
        fetch(DISPATCH_PATH, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(sessionId === ""
            ? { workspaceId: row.workspaceId, nodeId: row.nodeId, objective: text, sessionMode: "new" }
            : { workspaceId: row.workspaceId, nodeId: row.nodeId, objective: text, sessionMode: "resume", sessionId: sessionId })
        })
          .then(function (response) { return response.json(); })
          .then(function (data) {
            if (data && data.ok === true) {
              var summary = (data.result && data.result.summary) || "";
              setSend({ phase: "done", tone: "ok", message: t("完成", "done") + (data.state ? " · " + data.state : ""), summary: summary, code: "" });
              setText("");
            } else {
              var err = (data && data.error) || {};
              setSend({ phase: "done", tone: "err", message: (err.code || "error") + (err.message ? " · " + err.message : ""), summary: "", code: err.code || "" });
            }
          })
          .catch(function (error) {
            setSend({ phase: "done", tone: "err", message: String((error && error.message) || error), summary: "", code: "" });
          });
      }

      return jsx.jsxs("div", { className: "dwm-form", children: [
        jsx.jsx("h3", { className: "dwm-h3", children: t("远程工作区", "Remote workspaces") }),
        jsx.jsx("p", { className: "dwm-note", children: t(
          "这些工作区在别的机器上：文件、shell、模型调用都在那台机器执行，这里只发一条消息并取回最终回复。断网或对端离线时状态为离线，发送会直接报错。",
          "These workspaces live on other machines: files, shell and model calls run there. This page only sends a message and reads the final reply; when the peer is unreachable the status is offline and sending fails fast."
        ) }),
        jsx.jsx("div", { className: "dwm-row", children: [
          jsx.jsx("label", { className: "dwm-label", children: t("目标工作区", "Workspace") }),
          jsx.jsx("select", {
            className: "dwm-select",
            value: selected,
            onChange: function (event) { setSelected(event.target.value); },
            children: options.map(function (row) {
              return jsx.jsx("option", {
                value: row.nodeId + "/" + row.workspaceId,
                children: (row.label || row.workspaceId) + " · " + (row.nodeLabel || row.nodeId) + (row.path ? " · " + row.path : "") + (row.status === "online" ? "" : " (" + t("离线", "offline") + ")")
              }, row.nodeId + "/" + row.workspaceId);
            })
          })
        ] }, "pick"),
        jsx.jsx("div", { className: "dwm-row", children: [
          jsx.jsx("label", { className: "dwm-label", children: t("会话", "Session") }),
          jsx.jsx("select", {
            className: "dwm-select",
            value: sessionId,
            onChange: function (event) { setSessionId(event.target.value); },
            children: [
              jsx.jsx("option", { value: "", children: t("新会话", "New session") }, "new")
            ].concat(sessions.map(function (item) {
              var label = (item.title || item.sessionId) + (item.busy ? " · " + t("运行中", "running") : "");
              return jsx.jsx("option", { value: item.sessionId, children: label }, item.sessionId);
            }))
          })
        ] }, "sess"),
        sessionId === "" ? null : jsx.jsxs("div", { className: "dwm-row", children: [
          jsx.jsx("label", { className: "dwm-label", children: t("会话历史", "History") + (history.phase === "loading" ? " · " + t("读取中…", "loading...") : "") }),
          history.phase === "error"
            ? jsx.jsx("p", { className: "dwm-note", children: history.error })
            : jsx.jsx("div", {
                className: "dwm-mono",
                style: { maxHeight: "240px", overflowY: "auto", fontSize: "12px", lineHeight: "18px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "6px", padding: "8px" },
                children: history.messages.length === 0
                  ? t("（这个会话还没有消息）", "(no messages yet)")
                  : history.messages.map(function (item) {
                      return jsx.jsxs("div", { style: { marginBottom: "6px" }, children: [
                        jsx.jsx("span", { style: { opacity: 0.6 }, children: (item.role === "user" ? t("我", "user") : item.role === "assistant" ? t("助手", "assistant") : item.role) + " #" + item.seq + "  " }),
                        jsx.jsx("span", { children: item.text })
                      ] }, item.seq);
                    })
              })
        ] }, "hist"),
        jsx.jsx("div", { className: "dwm-row", children: [
          jsx.jsx("label", { className: "dwm-label", children: t("消息", "Message") }),
          jsx.jsx("textarea", {
            className: "dwm-input",
            rows: 3,
            value: text,
            placeholder: t("要在这台机器的这个工作区里做的事…", "What should run in that workspace on that machine..."),
            onChange: function (event) { setText(event.target.value); }
          })
        ] }, "msg"),
        jsx.jsx("div", { className: "dwm-actions", children: [
          jsx.jsx("button", { className: "dwm-btn", disabled: disabled, onClick: submit, children: sending ? t("发送中…", "Sending...") : t("发送", "Send") }),
          send.message ? jsx.jsx("span", { className: "dwm-status", "data-tone": send.tone, children: send.message }) : null
        ] }, "act"),
        send.summary ? jsx.jsx("pre", { className: "dwm-mono", style: { whiteSpace: "pre-wrap", margin: 0, fontSize: "12px" }, children: send.summary }, "sum") : null
      ] });
    }

    /**
     * Settings page: read-only mesh runtime snapshot. Data comes from the host
     * route /api/mesh/state; live configuration editing stays on the plugin
     * detail page because this DSH version does not project a profile-patch
     * entry into the settings document.
     */
    function MeshSection(props) {
      var st = React.useState({ phase: "loading", data: null, error: "", status: 0, at: 0 });
      var state = st[0], set = st[1];
      var load = React.useCallback(function () {
        if (typeof fetch !== "function") {
          set({ phase: "error", data: null, error: "当前页面没有 fetch", status: 0, at: Date.now() });
          return;
        }
        fetch(STATE_PATH, { method: "GET", credentials: "same-origin", headers: { accept: "application/json" } })
          .then(function (response) {
            if (!response.ok) {
              var error = new Error("HTTP " + response.status);
              error.status = response.status;
              throw error;
            }
            return response.json();
          })
          .then(function (data) {
            set({ phase: "ready", data: data, error: "", status: 200, at: Date.now() });
          })
          .catch(function (err) {
            set(function (previous) {
              return { phase: "error", data: previous.data, error: String((err && err.message) || err), status: (err && err.status) || 0, at: Date.now() };
            });
          });
      }, []);
      // On demand, not on a timer. This snapshot fans out to every peer (a
      // registry read plus its whole session list), so a 5s poll asked each peer
      // for everything three times a minute whether or not anyone was looking.
      // Reading on open, on return to the tab and on the refresh button keeps it
      // current where it matters and costs nothing while it sits idle.
      React.useEffect(function () {
        load();
        if (typeof document === "undefined") return;
        var onVisible = function () { if (!document.hidden) load(); };
        document.addEventListener("visibilitychange", onVisible);
        return function () { document.removeEventListener("visibilitychange", onVisible); };
      }, [load]);

      // Configuration form state. Values are read from the served snapshot and
      // only the touched keys are posted, so a stale page cannot overwrite a
      // field the user never edited.
      var fs = React.useState({ dirty: {}, saving: false, message: "", tone: "warn" });
      var form = fs[0], setForm = fs[1];
      function setField(key, value) {
        setForm(function (previous) {
          var dirty = Object.assign({}, previous.dirty);
          dirty[key] = value;
          return Object.assign({}, previous, { dirty: dirty, message: "", tone: "warn" });
        });
      }
      function saveConfig() {
        var dirty = form.dirty;
        var keys = Object.keys(dirty);
        if (keys.length === 0) return;
        var payload = {};
        for (var i = 0; i < keys.length; i++) {
          var key = keys[i];
          var field = null;
          for (var j = 0; j < CONFIG_FIELDS.length; j++) if (CONFIG_FIELDS[j].key === key) field = CONFIG_FIELDS[j];
          var value = dirty[key];
          if (field && field.kind === "number") value = Number(value);
          payload[key] = value;
        }
        setForm(function (previous) { return Object.assign({}, previous, { saving: true, message: "保存中…", tone: "warn" }); });
        fetch(CONFIG_PATH, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(payload)
        }).then(function (response) {
          return response.json().then(function (body) { return { ok: response.ok, body: body }; });
        }).then(function (result) {
          if (!result.ok || !result.body || result.body.ok !== true) {
            setForm(function (previous) {
              return Object.assign({}, previous, { saving: false, message: (result.body && result.body.error) || "保存失败", tone: "err" });
            });
            return;
          }
          var pending = result.body.pendingRestart || [];
          setForm({
            dirty: {},
            saving: false,
            message: pending.length === 0 ? "已保存并实时生效" : "已保存；重启后生效：" + pending.join("、"),
            tone: "ok"
          });
          if (result.body.state) {
            set({ phase: "ready", data: result.body.state, error: "", status: 200, at: Date.now() });
          }
        }).catch(function (err) {
          setForm(function (previous) {
            return Object.assign({}, previous, { saving: false, message: "保存失败：" + String((err && err.message) || err), tone: "err" });
          });
        });
      }

      var data = state.data;
      var header = [
        jsx.jsx("h2", { className: "dwm-h2", children: t("工作区网格", "Workspace mesh") }, "h2"),
        jsx.jsx("p", { className: "dwm-intro", children: t(
          "本机 mesh 运行时快照：传输状态、节点、工作区分布与近期任务。数据只读；打开本页、切回本页或点「立即刷新」时重新读取。",
          "Local mesh snapshot: transport, peers, workspace placement and recent tasks. Read-only; re-read when the page opens, when the tab regains focus, or on Refresh."
        ) }, "intro")
      ];

      if (!data && state.phase === "loading") {
        return jsx.jsxs("div", { className: "dwm-page", children: header.concat([jsx.jsx("p", { className: "dwm-note", children: "正在读取 mesh 状态…" }, "loading")]) });
      }
      if (!data && state.phase === "error") {
        var reason = state.status === 401 || state.status === 403
          ? t("会话未认证：请重新登录后再打开本页。", "Session not authenticated: sign in again and reopen this page.")
          : state.status === 404
            ? t("宿主未提供 /api/mesh/state（插件主机侧未挂载 connection.fetch）。", "Host does not serve /api/mesh/state (connection.fetch is not mounted).")
            : state.error;
        return jsx.jsxs("div", { className: "dwm-page", children: header.concat([
          jsx.jsx("p", { className: "dwm-note", "data-tone": "warn", children: reason }, "err"),
          jsx.jsx("div", { className: "dwm-footer", children: [jsx.jsx("button", { className: "dwm-ghost", onClick: load, children: t("重试", "Retry") }, "retry")] }, "errActions")
        ]) });
      }

      var peers = (data && data.peers) || [];
      var tasks = (data && data.tasks) || [];
      var counts = (data && data.counts) || { total: 0, queued: 0, dispatched: 0, running: 0, done: 0, failed: 0, expired: 0 };
      var transport = (data && data.transport) || { configured: false, mode: "", kind: "", reason: "" };
      var assignment = (data && data.assignment) || { configured: false, file: "", nodes: 0, assignments: 0 };
      var notes = (data && data.notes) || [];
      var now = (data && data.generatedAt) || Date.now();
      var online = 0;
      for (var p = 0; p < peers.length; p++) if (peers[p].status === "online") online += 1;
      var workspaces = workspaceRows(peers).length;
      var active = counts.queued + counts.dispatched + counts.running;

      var transportValue = transport.configured ? String(transport.kind || "已配置") : t("未配置", "none");
      var transportHint = transport.configured ? "mode: " + transport.mode : t("没有可用传输", "no transport");

      var blocks = [];
      blocks.push(jsx.jsxs("div", { className: "dwm-grid", children: [
        jsx.jsx(Stat, { label: t("传输", "Transport"), value: transportValue, hint: transportHint }, "s1"),
        jsx.jsx(Stat, { label: t("节点", "Peers"), value: online + " / " + peers.length, hint: t("在线 / 已知", "online / known") }, "s2"),
        jsx.jsx(Stat, { label: t("工作区", "Workspaces"), value: String(workspaces), hint: assignment.configured ? "assignment.yml " + assignment.assignments + " 条路由" : t("未配置 assignment.yml", "no assignment.yml") }, "s3"),
        jsx.jsx(Stat, { label: t("任务", "Tasks"), value: active + " / " + counts.total, hint: t("活跃 / 累计", "active / total") }, "s4")
      ] }, "stats"));

      blocks.push(jsx.jsx(MeshTopology, {
        peers: peers,
        tasks: tasks,
        t: t,
        selfLabel: (data && data.config && data.config.leaseOwner ? String(data.config.leaseOwner) + " · " : "") + t("本机", "this node")
      }, "topology"));

      // Configuration form: the native settings document cannot edit a
      // profile-patch mounted entry, so the page writes the plugin's own
      // override file and reports which fields need a restart.
      var configValues = (data && data.config) || {};
      var configRows = CONFIG_FIELDS.map(function (field) {
        var current = form.dirty[field.key] !== undefined
          ? form.dirty[field.key]
          : (configValues[field.key] === undefined ? "" : String(configValues[field.key]));
        var control;
        if (field.kind === "select") {
          control = jsx.jsx("select", {
            className: "dwm-select",
            value: current,
            onChange: function (event) { setField(field.key, event.target.value); },
            children: field.options.map(function (option) { return jsx.jsx("option", { value: option, children: option }, option); })
          });
        } else {
          control = jsx.jsx("input", {
            className: "dwm-input",
            type: field.kind === "number" ? "number" : "text",
            value: current,
            onChange: function (event) { setField(field.key, event.target.value); }
          });
        }
        return jsx.jsxs("label", { className: "dwm-field", children: [
          jsx.jsx("span", { className: "dwm-label", children: field.label }),
          control,
          jsx.jsx("span", { className: "dwm-hint", children: field.hint })
        ] }, field.key);
      });
      blocks.push(jsx.jsxs("div", { className: "dwm-form", children: [
        jsx.jsx("h3", { className: "dwm-h3", children: t("插件配置", "Plugin configuration") }),
        jsx.jsx("p", { className: "dwm-note", children: t(
          "写入 " + ((data && data.configFile) || "mesh-config.json") + "，覆盖 profile patch 的默认值；租约与 assignment 立即生效，传输与 peers 需重启。",
          "Saved to " + ((data && data.configFile) || "mesh-config.json") + ", overriding the profile patch defaults. Lease fields and the assignment table apply immediately; transport and peer URL need a restart."
        ) }),
        jsx.jsx("div", { className: "dwm-fields", children: configRows }),
        jsx.jsxs("div", { className: "dwm-actions", children: [
          jsx.jsx("button", {
            className: "dwm-btn",
            disabled: Object.keys(form.dirty).length === 0 || form.saving,
            onClick: saveConfig,
            children: t("保存配置", "Save")
          }),
          form.message ? jsx.jsx("span", { className: "dwm-status", "data-tone": form.tone, children: form.message }) : null
        ] }, "actions")
      ] }, "config"));

      if (transport.reason) blocks.push(jsx.jsx("p", { className: "dwm-note", "data-tone": "warn", children: transport.reason }, "reason"));
      for (var n = 0; n < notes.length; n++) blocks.push(jsx.jsx("p", { className: "dwm-note", children: notes[n] }, "note" + n));

      blocks.push(jsx.jsx("h3", { className: "dwm-h3", children: t("节点", "Peers") }, "peerTitle"));
      if (peers.length === 0) {
        blocks.push(jsx.jsx("p", { className: "dwm-empty", children: t(
          "没有已知节点：配置 assignment.yml 或启用传输后这里会出现节点。",
          "No peers known yet: configure assignment.yml or enable a transport."
        ) }, "peerEmpty"));
      } else {
        var peerRows = peers.map(function (peer) {
          return jsx.jsxs("tr", { children: [
            jsx.jsxs("td", { children: [
              jsx.jsx("span", { children: peer.label || peer.nodeId }),
              jsx.jsx("span", { className: "dwm-mono", style: { marginLeft: "6px", opacity: .7 }, children: peer.nodeId })
            ] }, "n"),
            jsx.jsx("td", { children: jsx.jsx(Badge, { tone: peerTone(peer.status), children: peer.status === "online" ? t("在线", "online") : peer.status === "offline" ? t("离线", "offline") : t("未知", "unknown") }) }, "s"),
            jsx.jsx("td", { children: sourceText(peer.source) }, "src"),
            jsx.jsx("td", { children: (peer.workspaces && peer.workspaces.length ? peer.workspaces.length : (peer.assignedWorkspaceIds || []).length) + "" }, "w"),
            jsx.jsx("td", { className: "dwm-mono", children: peer.lastSeenAt ? fmtAgo(peer.lastSeenAt, now) : "—" }, "t")
          ] }, peer.nodeId);
        });
        blocks.push(jsx.jsx("table", { className: "dwm-table", children: [
          jsx.jsx("thead", { children: jsx.jsxs("tr", { children: [
            jsx.jsx("th", { children: t("节点", "Peer") }, "1"),
            jsx.jsx("th", { children: t("状态", "Status") }, "2"),
            jsx.jsx("th", { children: t("来源", "Source") }, "3"),
            jsx.jsx("th", { children: t("工作区", "Workspaces") }, "4"),
            jsx.jsx("th", { children: t("最近心跳", "Last seen") }, "5")
          ] }) }),
          jsx.jsx("tbody", { children: peerRows })
        ] }, "peerTable"));
      }

      blocks.push(jsx.jsx("h3", { className: "dwm-h3", children: t("工作区分布", "Workspace placement") }, "wsTitle"));
      var ws = workspaceRows(peers);
      if (ws.length === 0) {
        blocks.push(jsx.jsx("p", { className: "dwm-empty", children: t(
          "没有承载工作区的节点。",
          "No node carries a workspace yet."
        ) }, "wsEmpty"));
      } else {
        blocks.push(jsx.jsx("table", { className: "dwm-table", children: [
          jsx.jsx("thead", { children: jsx.jsxs("tr", { children: [
            jsx.jsx("th", { children: t("工作区", "Workspace") }, "1"),
            jsx.jsx("th", { children: t("所在服务器", "Server") }, "2"),
            jsx.jsx("th", { children: t("状态", "Status") }, "3"),
            jsx.jsx("th", { children: t("远端目录", "Remote path") }, "4"),
            jsx.jsx("th", { children: t("来源", "Source") }, "5")
          ] }) }),
          jsx.jsx("tbody", { children: ws.map(function (row, index) {
            return jsx.jsxs("tr", { children: [
              jsx.jsxs("td", { children: [
                jsx.jsx("span", { children: row.label || row.workspaceId }),
                row.label ? jsx.jsx("span", { className: "dwm-mono", style: { marginLeft: "6px", opacity: .7 }, children: row.workspaceId }) : null
              ] }, "w"),
              jsx.jsxs("td", { children: [
                jsx.jsx("span", { children: row.nodeLabel || row.nodeId }),
                jsx.jsx("span", { className: "dwm-mono", style: { marginLeft: "6px", opacity: .7 }, children: row.nodeId }),
                row.endpoint ? jsx.jsx("div", { className: "dwm-mono", style: { opacity: .55, fontSize: "11px" }, children: row.endpoint }) : null
              ] }, "n"),
              jsx.jsx("td", { children: jsx.jsx(Badge, { tone: peerTone(row.status), children: row.status === "online" ? t("在线", "online") : row.status === "offline" ? t("离线", "offline") : t("未知", "unknown") }) }, "s"),
              jsx.jsx("td", { className: "dwm-mono", children: row.path || "—" }, "p"),
              jsx.jsx("td", { children: sourceText(row.source) }, "src")
            ] }, row.nodeId + "/" + row.workspaceId + "/" + index);
          }) })
        ] }, "wsTable"));
      }

      blocks.push(jsx.jsx(RemoteWorkspacePanel, { rows: ws }, "remoteWs"));

      blocks.push(jsx.jsx("h3", { className: "dwm-h3", children: t("近期任务", "Recent tasks") }, "taskTitle"));
      if (tasks.length === 0) {
        blocks.push(jsx.jsx("p", { className: "dwm-empty", children: t(
          "还没有通过 mesh 派发的任务。Agent 调用 mesh_dispatch 后这里会出现记录。",
          "No mesh-dispatched tasks yet. They appear here after an agent calls mesh_dispatch."
        ) }, "taskEmpty"));
      } else {
        blocks.push(jsx.jsx("table", { className: "dwm-table", children: [
          jsx.jsx("thead", { children: jsx.jsxs("tr", { children: [
            jsx.jsx("th", { children: t("任务", "Task") }, "1"),
            jsx.jsx("th", { children: t("状态", "State") }, "2"),
            jsx.jsx("th", { children: t("目标", "Target") }, "3"),
            jsx.jsx("th", { children: t("最近更新", "Updated") }, "4")
          ] }) }),
          jsx.jsx("tbody", { children: tasks.map(function (task) {
            return jsx.jsxs("tr", { children: [
              jsx.jsxs("td", { children: [
                jsx.jsx("div", { children: task.objective || task.taskId }),
                jsx.jsx("div", { className: "dwm-mono", style: { opacity: .7 }, children: task.taskId })
              ] }, "t"),
              jsx.jsx("td", { children: jsx.jsx(Badge, { tone: taskTone(task.state), children: stateText(task.state) }) }, "s"),
              jsx.jsx("td", { className: "dwm-mono", children: task.nodeId + " / " + task.workspaceId }, "g"),
              jsx.jsx("td", { className: "dwm-mono", children: fmtAgo(task.updatedAt, now) }, "u")
            ] }, task.taskId);
          }) })
        ] }, "taskTable"));
      }

      blocks.push(jsx.jsxs("div", { className: "dwm-footer", children: [
        jsx.jsx("span", { children: t("更新于 ", "updated ") + (state.at ? fmtClock(state.at) : "—") }, "time"),
        jsx.jsx("button", { className: "dwm-ghost", onClick: load, children: t("立即刷新", "Refresh") }, "refresh"),
        jsx.jsx("span", { children: t("快照只读；配置更改写入 mesh-config.json", "Snapshot is read-only; config changes go to mesh-config.json") }, "hint"),
        state.phase === "error" ? jsx.jsx("span", { "data-tone": "warn", children: t("上次刷新失败：", "last refresh failed: ") + state.error }) : null
      ] }, "footer"));

      return jsx.jsxs("div", { className: "dwm-page", children: header.concat(blocks) });
    }

    /**
     * Browser half of the mesh settings surface: a read-only mesh page in the
     * native settings navigation (settings.section) plus the live-configuration
     * card on the plugin's own detail page (plugins.detail.section).
     */
    function apply(ctx) {
      ctx.slots.inject("plugins.detail.section", function () {
        return ctx.slots.register({
          name: "plugins.detail.section",
          id: "mesh-config",
        }, function (props) {
          return ConfigSection(Object.assign({}, props, { ctx: ctx }));
        });
      });
      // Left-rail entry + full page: reachable without opening settings.
      ctx.slots.inject("sidebar.panellist", function () {
        return ctx.slots.register({
          name: "sidebar.panellist",
          id: "mesh",
          order: 15,
          label: function () { return t("工作区网格", "Workspace mesh"); }
        }, MeshPanelIcon);
      });
      ctx.slots.inject("main", function () {
        return ctx.slots.register({
          name: "main",
          key: "mesh",
          label: function () { return t("工作区网格", "Workspace mesh"); }
        }, MeshWorkspacePage);
      });

      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({
          name: "settings.section",
          id: "mesh",
          order: 25,
          label: function () { return t("工作区网格", "Workspace mesh"); }
        }, function (props) {
          // The slot host swallows a render error into an empty box; keep the
          // message on screen so a broken canvas is diagnosable.
          return jsx.jsx(TopoBoundary, { t: t, children: jsx.jsx(MeshSection, Object.assign({}, props, { ctx: ctx })) });
        });
      });

      // Optional composition: when dsh-proton-workspace is mounted, offer this
      // mesh as one workspace source so "add workspace" can pick a remote one.
      // Everything above works without it; when proton is absent the callback
      // below never runs, because no one ever provides protonWorkspace.
      if (typeof ctx.inject === "function") {
        ctx.inject(["protonWorkspace"], function (scoped) {
          scoped.effect(function () {
            return scoped.protonWorkspace.addSource(createMeshWorkspaceSource());
          }, "mesh: proton workspace source");
        });
      }
    }

    /** Left-rail icon: a hub with two peers. */
    function MeshPanelIcon() {
      return jsx.jsxs("svg", {
        width: 20, height: 20, viewBox: "0 0 20 20", fill: "none", "aria-hidden": "true",
        children: [
          jsx.jsx("circle", { cx: 4.5, cy: 10, r: 2.1, stroke: "currentColor", strokeWidth: 1.4 }),
          jsx.jsx("circle", { cx: 15.5, cy: 5, r: 2.1, stroke: "currentColor", strokeWidth: 1.4 }),
          jsx.jsx("circle", { cx: 15.5, cy: 15, r: 2.1, stroke: "currentColor", strokeWidth: 1.4 }),
          jsx.jsx("path", { d: "M6.6 9.2 L13.4 5.8 M6.6 10.8 L13.4 14.2", stroke: "currentColor", strokeWidth: 1.2, strokeLinecap: "round" })
        ]
      });
    }

    /**
     * Full-page panel: every workspace this instance can reach, which machine
     * owns it, and a box to send that workspace a message. A remote workspace is
     * virtual here — the page never touches its files, it only posts a message
     * and shows the reply the owning machine produced.
     */
    function MeshWorkspacePage() {
      var st = React.useState({ phase: "loading", data: null, error: "", at: 0 });
      var state = st[0];
      var set = st[1];
      var load = React.useCallback(function () {
        fetch(STATE_PATH, { method: "GET", credentials: "same-origin", headers: { accept: "application/json" } })
          .then(function (response) {
            if (!response.ok) throw new Error("HTTP " + response.status);
            return response.json();
          })
          .then(function (data) { set({ phase: "ready", data: data, error: "", at: Date.now() }); })
          .catch(function (err) { set({ phase: "error", data: null, error: String((err && err.message) || err), at: Date.now() }); });
      }, []);
      // Same rule as the settings section: the fan-out is paid for when someone
      // asks for it, not on a timer nobody watches.
      React.useEffect(function () {
        load();
        if (typeof document === "undefined") return;
        var onVisible = function () { if (!document.hidden) load(); };
        document.addEventListener("visibilitychange", onVisible);
        return function () { document.removeEventListener("visibilitychange", onVisible); };
      }, [load]);

      var data = state.data || {};
      var peers = data.peers || [];
      var rows = workspaceRows(peers);
      var online = 0;
      for (var i = 0; i < rows.length; i += 1) if (rows[i].status === "online") online += 1;

      return jsx.jsxs("div", { className: "dwm-page", children: [
        jsx.jsx("h2", { className: "dwm-h2", children: t("工作区网格", "Workspace mesh") }),
        jsx.jsx("p", { className: "dwm-intro", children: state.phase === "error"
          ? t("读取 mesh 状态失败：", "Failed to read mesh state: ") + state.error
          : t("每个工作区都属于某台机器：消息传过去，执行留在那台机器上。", "Each workspace belongs to one machine: the message travels, the work stays there.") }),
        jsx.jsxs("div", { className: "dwm-grid", children: [
          jsx.jsx(Stat, { label: t("在线工作区", "Online"), value: String(online) }, "s1"),
          jsx.jsx(Stat, { label: t("工作区总数", "Total"), value: String(rows.length) }, "s2")
        ] }, "stats"),
        jsx.jsx(RemoteWorkspacePanel, { rows: rows }, "remote"),
        jsx.jsxs("div", { className: "dwm-footer", children: [
          jsx.jsx("span", { children: t("更新于 ", "updated ") + (state.at ? fmtClock(state.at) : "—") }, "time"),
          jsx.jsx("button", { className: "dwm-ghost", onClick: load, children: t("立即刷新", "Refresh") }, "refresh")
        ] }, "footer"),
        jsx.jsx("p", { className: "dwm-note", children: t(
          "断网或对端离线时，工作区状态变离线，发送会直接失败——不会留下半截任务。",
          "When the network or the peer is down the workspace turns offline and sending fails fast; nothing is left half-queued."
        ) })
      ] });
    }


export { apply, inject };
