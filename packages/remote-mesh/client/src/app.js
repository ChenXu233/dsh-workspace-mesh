// Browser half of the workspace mesh: converted from the hand-written
// single-file bundle so the topology can carry a real interactive canvas.
// scripts/build-client.mjs wraps this module back into the
// window.__ModuleLoader__.load({ id, factory }) shape the host expects.
import * as React from "react";
import * as jsx from "react/jsx-runtime";
// Official atoms from the frozen platform table: buttons, inputs, tags.
import { Button as OfficialButton, IconChevronDownOutlineRegular, Input as OfficialInput, Menu as OfficialMenu } from "@deepseek-ai/dsh-client-ui-primitives";
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
    // One-click pairing: this node hands out a link, the other machine imports it.
    var HUB_LINK_PATH = "/api/mesh/hub-link";
    var HUB_ADOPT_PATH = "/api/mesh/hub-adopt";
    var HUB_PARAM = "mesh-hub";
    var PAIR_ADDRESS_PATH = "/api/mesh/pair-address";
    var PAIR_LINK_PATH = "/api/mesh/pair-link";
    var PAIR_PATH = "/api/mesh/pair";
    var PAIR_PARAM = "mesh-pair";

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

    // Official page recipe (ui-plugin-manager): centred column, clamp() insets,
    // 20px/500 title + 13px secondary intro, 32px gaps, hairline separators.
    // Controls come from @deepseek-ai/dsh-client-ui-primitives.
    var css = [
      ".dwm-page{display:flex;flex-direction:column;align-items:center;height:100%;box-sizing:border-box;padding:0 clamp(24px,4vw,48px) 48px;color:var(--dsw-alias-label-primary);overflow-y:auto}",
      ".dwm-page>*{flex:none;width:100%;max-width:960px}",
      ".dwm-head{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:16px;padding-top:28px}",
      ".dwm-headText{flex:1 1 0%;min-width:0;max-width:100%}",
      ".dwm-h2{margin:0;font-size:20px;font-weight:500;line-height:28px}",
      ".dwm-intro{margin:4px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}",
      ".dwm-body{display:flex;flex-direction:column;gap:32px;padding:32px 0 0}",
      ".dwm-section{display:flex;flex-direction:column;gap:12px}",
      ".dwm-h3{margin:0;font-size:14px;font-weight:600;line-height:22px}",
      ".dwm-row{display:flex;flex-direction:column;gap:6px}",
      ".dwm-label{font-size:13px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary)}",
      ".dwm-hint{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}",
      ".dwm-hint[data-tone=ok]{color:var(--dsw-alias-state-success)}",
      ".dwm-hint[data-tone=err]{color:var(--dsw-alias-state-danger)}",
      ".dwm-select{display:flex;align-items:center;gap:12px;width:100%;height:36px;box-sizing:border-box;padding:0 14px;border:0;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;cursor:pointer;text-align:left}",
      ".dwm-select:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dwm-select:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}",
      ".dwm-selectText{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dwm-selectChevron{flex:none}",
      ".dwm-actions{display:flex;flex:none;align-items:center;gap:8px;flex-wrap:wrap}",
      ".dwm-footer{display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-caption)}",
      ".dwm-grid{display:flex;gap:48px;flex-wrap:wrap}",
      ".dwm-stat{display:flex;flex-direction:column;gap:2px;min-width:0}",
      ".dwm-statLabel{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
      ".dwm-statValue{font-size:20px;font-weight:500;line-height:28px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dwm-statHint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dwm-table{width:100%;border-collapse:collapse;font-size:13px}",
      ".dwm-table th{padding:8px 10px;font-size:12px;font-weight:500;text-align:left;color:var(--dsw-alias-label-secondary);border-bottom:.5px solid var(--dsw-alias-border-l2);white-space:nowrap}",
      ".dwm-table td{padding:10px;vertical-align:middle;border-bottom:.5px solid var(--dsw-alias-border-l1)}",
      ".dwm-table tr:last-child td{border-bottom:0}",
      ".dwm-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}",
      ".dwm-badge{display:inline-flex;align-items:center;gap:4px;border-radius:999px;padding:0 8px;height:20px;font-size:11px;line-height:20px;border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap}",
      ".dwm-badge[data-tone=ok]{color:var(--dsw-alias-state-success);border-color:currentColor}",
      ".dwm-badge[data-tone=err]{color:var(--dsw-alias-state-danger);border-color:currentColor}",
      ".dwm-note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-caption)}",
      ".dwm-note[data-tone=warn]{color:var(--dsw-alias-label-secondary)}",
      ".dwm-pair-row{display:flex;align-items:center;gap:8px;max-width:720px}",
      ".dwm-pair-row>.dwm-grow{flex:1;min-width:0}",
      ".dwm-empty{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}",
      ".dwm-textarea{width:100%;box-sizing:border-box;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-secondary);color:inherit;font:inherit;font-size:13px;line-height:20px;resize:vertical}",
      ".dwm-textarea:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}",
      ".dwm-status{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
      ".dwm-status[data-tone=ok]{color:var(--dsw-alias-state-success)}",
      ".dwm-status[data-tone=err]{color:var(--dsw-alias-state-danger)}",
      ".dwm-fields{display:flex;flex-direction:column;gap:16px}",
      ".dwm-field{display:flex;flex-direction:column;gap:6px}",
    ].join("") + TOPOLOGY_CSS;
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

    /** Official button: one visual language for every action on the page. */
    function Btn(props) {
      return jsx.jsx(OfficialButton, {
        variant: props.variant || "outline",
        size: props.size || "sm",
        disabled: props.disabled === true,
        onClick: props.onClick,
        children: props.children
      });
    }

    /** Official text input, stretched to the row it sits in. */
    function TextInput(props) {
      return jsx.jsx(OfficialInput, {
        className: props.grow === false ? undefined : "dwm-grow",
        type: props.type,
        value: props.value,
        placeholder: props.placeholder,
        readOnly: props.readOnly === true,
        onChange: props.onChange,
        onFocus: props.onFocus
      });
    }

    /** Human label for where a pairing address came from. */
    function addressSourceText(source) {
      if (source === "config") return t("mesh 配置里的 publicUrl", "publicUrl in the mesh config");
      if (source === "env") return t("环境变量 DSH_PUBLIC_URL", "the DSH_PUBLIC_URL environment variable");
      if (source === "request") return t("你当前访问这个页面的地址", "the address you opened this page at");
      if (source === "lan") return t("本机网卡（当前访问的是 127.0.0.1）", "this machine's network card (you are on 127.0.0.1)");
      if (source === "custom") return t("你手动填写的地址", "the address you typed");
      return t("无法判断：请手动填写", "unknown - please fill it in");
    }

    /**
     * Official selector: a pill trigger that opens the same anchored Menu the
     * language row uses, instead of a native <select>.
     * @param props.value - selected option id.
     * @param props.options - `{ value, label }` rows.
     * @param props.onChange - called with the chosen id.
     * @param props.label - trigger text (defaults to the selected row's label).
     * @returns the trigger and its menu.
     */
    function SelectField(props) {
      var openState = React.useState(false);
      var open = openState[0];
      var setOpen = openState[1];
      var shown = props.label;
      for (var i = 0; i < props.options.length; i += 1) {
        if (props.options[i].value === props.value && props.options[i].label) shown = props.options[i].label;
      }
      return jsx.jsx(OfficialMenu, {
        open: open,
        onClose: function () { setOpen(false); },
        items: props.options.map(function (option) { return { id: option.value, label: option.label }; }),
        selectedId: props.value,
        onSelect: function (id) {
          props.onChange(id);
          setOpen(false);
        },
        align: props.align || "start",
        portal: true,
        anchor: jsx.jsxs("button", {
          type: "button",
          className: "dwm-select",
          "aria-haspopup": "menu",
          "aria-expanded": open,
          onClick: function () { setOpen(!open); },
          children: [
            jsx.jsx("span", { className: "dwm-selectText", children: shown }),
            jsx.jsx(IconChevronDownOutlineRegular, { className: "dwm-selectChevron" })
          ]
        })
      });
    }

    function prefersChinese() {
      if (typeof document !== "undefined" && document.documentElement && document.documentElement.lang) {
        return /^zh/i.test(document.documentElement.lang);
      }
      if (typeof navigator !== "undefined" && navigator.language) return /^zh/i.test(navigator.language);
      return true;
    }
    function t(zh, en) { return prefersChinese() ? zh : en; }

    /** The plugin detail page configuration card (kept from the first increment). */
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
        return jsx.jsxs("div", { className: "dwm-section", children: [
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

      return jsx.jsxs("div", { className: "dwm-section", children: [
        jsx.jsx("h3", { className: "dwm-h3", children: t("远程工作区", "Remote workspaces") }),
        jsx.jsx("p", { className: "dwm-note", children: t(
          "这些工作区在别的机器上：文件、shell、模型调用都在那台机器执行，这里只发一条消息并取回最终回复。断网或对端离线时状态为离线，发送会直接报错。",
          "These workspaces live on other machines: files, shell and model calls run there. This page only sends a message and reads the final reply; when the peer is unreachable the status is offline and sending fails fast."
        ) }),
        jsx.jsx("div", { className: "dwm-row", children: [
          jsx.jsx("label", { className: "dwm-label", children: t("目标工作区", "Workspace") }),
          jsx.jsx(SelectField, {
            value: selected,
            onChange: function (next) { setSelected(next); },
            options: options.map(function (row) {
              return {
                value: row.nodeId + "/" + row.workspaceId,
                label: (row.label || row.workspaceId) + " · " + (row.nodeLabel || row.nodeId) + (row.path ? " · " + row.path : "") + (row.status === "online" ? "" : " (" + t("离线", "offline") + ")")
              };
            })
          })
        ] }, "pick"),
        jsx.jsx("div", { className: "dwm-row", children: [
          jsx.jsx("label", { className: "dwm-label", children: t("会话", "Session") }),
          jsx.jsx(SelectField, {
            value: sessionId,
            onChange: function (next) { setSessionId(next); },
            options: [{ value: "", label: t("新会话", "New session") }].concat(sessions.map(function (item) {
              return { value: item.sessionId, label: (item.title || item.sessionId) + (item.busy ? " · " + t("运行中", "running") : "") };
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
            className: "dwm-textarea",
            rows: 3,
            value: text,
            placeholder: t("要在这台机器的这个工作区里做的事…", "What should run in that workspace on that machine..."),
            onChange: function (event) { setText(event.target.value); }
          })
        ] }, "msg"),
        jsx.jsx("div", { className: "dwm-actions", children: [
          jsx.jsx(Btn, { variant: "primary", disabled: disabled, onClick: submit, children: sending ? t("发送中…", "Sending...") : t("发送", "Send") }),
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
      var header = jsx.jsxs("header", { className: "dwm-head", children: [
        jsx.jsxs("div", { className: "dwm-headText", children: [
          jsx.jsx("h1", { className: "dwm-h2", children: t("工作区网格", "Workspace mesh") }, "h2"),
          jsx.jsx("p", { className: "dwm-intro", children: t(
            "本机 mesh 运行时快照：传输状态、节点、工作区分布与近期任务。数据只读；打开本页、切回本页或点「刷新」时重新读取。",
            "Local mesh snapshot: transport, peers, workspace placement and recent tasks. Read-only; re-read when the page opens, when the tab regains focus, or on Refresh."
          ) }, "intro")
        ] }, "text"),
        jsx.jsx("div", { className: "dwm-actions", children: jsx.jsx(Btn, { onClick: load, children: t("刷新", "Refresh") }, "refresh") }, "actions")
      ] }, "head");

      if (!data && state.phase === "loading") {
        return jsx.jsxs("div", { className: "dwm-page", children: [header, jsx.jsx("div", { className: "dwm-body", children: jsx.jsx("p", { className: "dwm-note", children: "正在读取 mesh 状态…" }) }, "body")] });
      }
      if (!data && state.phase === "error") {
        var reason = state.status === 401 || state.status === 403
          ? t("会话未认证：请重新登录后再打开本页。", "Session not authenticated: sign in again and reopen this page.")
          : state.status === 404
            ? t("宿主未提供 /api/mesh/state（插件主机侧未挂载 connection.fetch）。", "Host does not serve /api/mesh/state (connection.fetch is not mounted).")
            : state.error;
        return jsx.jsxs("div", { className: "dwm-page", children: [header, jsx.jsx("div", { className: "dwm-body", children: [
          jsx.jsx("p", { className: "dwm-note", "data-tone": "warn", children: reason }, "err"),
          jsx.jsx("div", { className: "dwm-actions", children: [jsx.jsx(Btn, { onClick: load, children: t("重试", "Retry") }, "retry")] }, "errActions")
        ] }, "body")] });
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

      // Pairing lives here now that the standalone page is gone: it is the one
      // action on this page that changes configuration rather than showing it.
      blocks.push(jsx.jsx(PairingPanel, { onPaired: load }, "pair"));
      blocks.push(jsx.jsx(DomainPanel, { onPaired: load }, "domain"));

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
          control = jsx.jsx(SelectField, {
            value: current,
            onChange: function (next) { setField(field.key, next); },
            options: field.options.map(function (option) { return { value: option, label: option }; })
          });
        } else {
          control = jsx.jsx(TextInput, {
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
      blocks.push(jsx.jsxs("div", { className: "dwm-section", children: [
        jsx.jsx("h3", { className: "dwm-h3", children: t("插件配置", "Plugin configuration") }),
        jsx.jsx("p", { className: "dwm-note", children: t(
          "写入 " + ((data && data.configFile) || "mesh-config.json") + "，覆盖 profile patch 的默认值；租约与 assignment 立即生效，传输与 peers 需重启。",
          "Saved to " + ((data && data.configFile) || "mesh-config.json") + ", overriding the profile patch defaults. Lease fields and the assignment table apply immediately; transport and peer URL need a restart."
        ) }),
        jsx.jsx("div", { className: "dwm-fields", children: configRows }),
        jsx.jsxs("div", { className: "dwm-actions", children: [
          jsx.jsx(Btn, {
            variant: "primary",
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
        jsx.jsx(Btn, { onClick: load, children: t("立即刷新", "Refresh") }, "refresh"),
        jsx.jsx("span", { children: t("快照只读；配置更改写入 mesh-config.json", "Snapshot is read-only; config changes go to mesh-config.json") }, "hint"),
        state.phase === "error" ? jsx.jsx("span", { "data-tone": "warn", children: t("上次刷新失败：", "last refresh failed: ") + state.error }) : null
      ] }, "footer"));

      return jsx.jsxs("div", { className: "dwm-page", children: [header, jsx.jsx("div", { className: "dwm-body", children: blocks }, "body")] });
    }

    /**
     * Browser half of the mesh settings surface: a read-only mesh page in the
     * native settings navigation (settings.section) plus the live-configuration
     * card on the plugin's own detail page (plugins.detail.section).
     */
    /**
     * Domain panel: make this machine a hub, or join someone else's.
     *
     * A hub is just a public node others can dial; it keeps the directory and
     * buffers requests for nodes without inbound ports. Joining is one link.
     */
    function DomainPanel(props) {
      var outState = React.useState({ phase: "idle", link: "", message: "", tone: "" });
      var out = outState[0];
      var setOut = outState[1];
      var inState = React.useState("");
      var incoming = inState[0];
      var setIncoming = inState[1];
      var joinState = React.useState({ phase: "idle", message: "", tone: "" });
      var joined = joinState[0];
      var setJoined = joinState[1];

      function makeLink() {
        setOut({ phase: "loading", link: "", message: t("生成中…", "Generating…"), tone: "warn" });
        fetch(HUB_LINK_PATH, { credentials: "same-origin", headers: { accept: "application/json" } })
          .then(function (response) { return response.json(); })
          .then(function (data) {
            if (!data || data.ok !== true) throw new Error(String((data && data.error) || "hub link failed"));
            setOut({ phase: "ready", link: data.link, message: t("已生成，发给要加入的机器", "Generated - send it to the machine joining"), tone: "ok" });
            if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(data.link).catch(function () {});
            }
          })
          .catch(function (error) {
            setOut({ phase: "error", link: "", message: String((error && error.message) || error), tone: "err" });
          });
      }

      function adoptLink() {
        var token = incoming.trim();
        if (token === "") return;
        setJoined({ phase: "loading", message: t("加入中…", "Joining…"), tone: "warn" });
        fetch(HUB_ADOPT_PATH, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ link: token })
        })
          .then(function (response) { return response.json(); })
          .then(function (data) {
            if (!data || data.ok !== true) throw new Error(String((data && data.error) || "hub join failed"));
            setJoined({ phase: "ready", message: t("已加入 " + data.hub.url + "，正在注册", "Joined " + data.hub.url + "; registering"), tone: "ok" });
            setIncoming("");
            if (typeof props.onPaired === "function") props.onPaired();
          })
          .catch(function (error) {
            setJoined({ phase: "error", message: String((error && error.message) || error), tone: "err" });
          });
      }

      var busyOut = out.phase === "loading";
      var busyIn = joined.phase === "loading";
      return jsx.jsxs("div", { className: "dwm-section", children: [
        jsx.jsx("h3", { className: "dwm-h3", children: t("域（hub）", "Domain (hub)") }),
        jsx.jsx("p", { className: "dwm-hint", children: t(
          "让一台有公网的机器当主轴：它记节点目录，并替没有入站端口的机器缓冲请求。加入只需要主轴的一张链接，之后节点之间自动登记。",
          "Point one machine with a public address at this: it keeps the directory and buffers requests for nodes without inbound ports. Joining takes one link from the hub; nodes register themselves after that."
        ) }),
        jsx.jsxs("div", { className: "dwm-pair-row", children: [
          jsx.jsx(Btn, { variant: "primary", disabled: busyOut, onClick: makeLink, children: busyOut ? t("生成中…", "Generating…") : t("本机作为主轴：生成加入链接", "Make this machine a hub") }, "make")
        ] }, "make"),
        out.link === "" ? null : jsx.jsx(TextInput, {
          readOnly: true,
          value: out.link,
          onFocus: function (event) { event.target.select(); }
        }, "link"),
        out.message === "" ? null : jsx.jsx("p", { className: "dwm-hint", "data-tone": out.tone, children: out.message }, "out-msg"),
        jsx.jsxs("div", { className: "dwm-pair-row", children: [
          jsx.jsx(TextInput, {
            value: incoming,
            placeholder: t("粘贴主轴给的加入链接", "Paste the hub's join link"),
            onChange: function (event) { setIncoming(event.target.value); }
          }, "incoming"),
          jsx.jsx(Btn, { disabled: busyIn || incoming.trim() === "", onClick: adoptLink, children: busyIn ? t("加入中…", "Joining…") : t("加入域", "Join") }, "join")
        ] }, "adopt"),
        joined.message === "" ? null : jsx.jsx("p", { className: "dwm-hint", "data-tone": joined.tone, children: joined.message }, "in-msg")
      ] });
    }

    /**
     * One-click pairing panel.
     *
     * The link carries this node's URL and shared secret, so the other machine
     * needs no hand-edited JSON: open the link there and it becomes a peer.
     * Pairing is one-directional by nature — ask the other side for its link to
     * get the reverse direction.
     */
    function PairingPanel(props) {
      var nameState = React.useState("");
      var name = nameState[0];
      var setName = nameState[1];
      var outState = React.useState({ phase: "idle", link: "", message: "", tone: "" });
      var out = outState[0];
      var setOut = outState[1];
      var inState = React.useState("");
      var incoming = inState[0];
      var setIncoming = inState[1];
      var importState = React.useState({ phase: "idle", message: "", tone: "" });
      var imported = importState[0];
      var setImported = importState[1];
      // The address the link will carry. The host picks it (config -> env ->
      // page origin -> LAN card) and the operator can correct it here, because
      // a link that says 127.0.0.1 is useless on the other machine.
      var addrState = React.useState({ url: "", source: "", candidates: [] });
      var address = addrState[0];
      var setAddress = addrState[1];

      React.useEffect(function () {
        fetch(PAIR_ADDRESS_PATH, { credentials: "same-origin", headers: { accept: "application/json" } })
          .then(function (response) { return response.json(); })
          .then(function (data) {
            if (!data || data.ok !== true) return;
            setAddress({ url: data.url || "", source: data.source || "", candidates: data.candidates || [] });
          })
          .catch(function () { /* the field stays empty and the host still picks one */ });
      }, []);

      function makeLink() {
        setOut({ phase: "loading", link: "", message: t("生成中…", "Generating…"), tone: "warn" });
        var params = [];
        if (name.trim() !== "") params.push("nodeId=" + encodeURIComponent(name.trim()));
        if (address.url.trim() !== "") params.push("url=" + encodeURIComponent(address.url.trim()));
        var query = params.length === 0 ? "" : "?" + params.join("&");
        fetch(PAIR_LINK_PATH + query, { credentials: "same-origin", headers: { accept: "application/json" } })
          .then(function (response) { return response.json(); })
          .then(function (data) {
            if (!data || data.ok !== true) throw new Error(String((data && data.error) || "pair link failed"));
            setOut({ phase: "ready", link: data.link, message: t("已生成，复制给对方", "Generated - send it over"), tone: "ok" });
            if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(data.link).catch(function () {});
            }
          })
          .catch(function (error) {
            setOut({ phase: "error", link: "", message: String((error && error.message) || error), tone: "err" });
          });
      }

      function importLink() {
        var token = incoming.trim();
        if (token === "") return;
        setImported({ phase: "loading", message: t("导入中…", "Importing…"), tone: "warn" });
        fetch(PAIR_PATH, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ link: token })
        })
          .then(function (response) { return response.json(); })
          .then(function (data) {
            if (!data || data.ok !== true) throw new Error(String((data && data.error) || "pair import failed"));
            setImported({ phase: "ready", message: t("已配对：", "Paired: ") + data.peer.nodeId, tone: "ok" });
            setIncoming("");
            if (typeof props.onPaired === "function") props.onPaired();
          })
          .catch(function (error) {
            setImported({ phase: "error", message: String((error && error.message) || error), tone: "err" });
          });
      }

      var busyOut = out.phase === "loading";
      var busyIn = imported.phase === "loading";
      return jsx.jsxs("div", { className: "dwm-section", children: [
        jsx.jsx("h3", { className: "dwm-h3", children: t("一键配对", "Pair a machine") }),
        jsx.jsx("p", { className: "dwm-hint", children: t(
          "配对链接里带着这台机器的地址与共享密钥：在对方机器上打开它，两边就通了，不用手改 mesh-config.json。",
          "The link carries this machine's URL and shared secret: open it on the other machine and both sides are connected, with no hand-edited mesh-config.json."
        ) }),
        jsx.jsxs("div", { className: "dwm-pair-row", children: [
          jsx.jsx(TextInput, {
            value: address.url,
            placeholder: t("本机对外地址，例如 http://192.168.1.20:3211", "Address others use, e.g. http://192.168.1.20:3211"),
            onChange: function (event) { setAddress({ url: event.target.value, source: "custom", candidates: address.candidates }); }
          }, "address")
        ] }, "addr"),
        address.source === "" ? null : jsx.jsx("p", { className: "dwm-hint", children: t(
          "链接地址来源：" + addressSourceText(address.source) +
            (address.candidates.length > 1 ? "。可选：" + address.candidates.map(function (item) { return item.url; }).join(" / ") : ""),
          "Address source: " + addressSourceText(address.source) +
            (address.candidates.length > 1 ? ". Candidates: " + address.candidates.map(function (item) { return item.url; }).join(" / ") : "")
        ) }, "addr-hint"),
        jsx.jsxs("div", { className: "dwm-pair-row", children: [
          jsx.jsx(TextInput, {
            value: name,
            placeholder: t("对方怎么称呼这台机器（默认主机名）", "Name the other side uses for this machine (default: hostname)"),
            onChange: function (event) { setName(event.target.value); }
          }, "name"),
          jsx.jsx(Btn, { variant: "primary", disabled: busyOut, onClick: makeLink, children: busyOut ? t("生成中…", "Generating…") : t("生成配对链接", "Create link") }, "make")
        ] }, "make"),
        out.link === "" ? null : jsx.jsx(TextInput, {
          readOnly: true,
          value: out.link,
          onFocus: function (event) { event.target.select(); }
        }, "link"),
        out.message === "" ? null : jsx.jsx("p", { className: "dwm-hint", "data-tone": out.tone, children: out.message }, "out-msg"),
        jsx.jsxs("div", { className: "dwm-pair-row", children: [
          jsx.jsx(TextInput, {
            value: incoming,
            placeholder: t("粘贴对方的配对链接", "Paste the other machine's link"),
            onChange: function (event) { setIncoming(event.target.value); }
          }, "incoming"),
          jsx.jsx(Btn, { disabled: busyIn || incoming.trim() === "", onClick: importLink, children: busyIn ? t("导入中…", "Importing…") : t("导入", "Import") }, "import")
        ] }, "import"),
        imported.message === "" ? null : jsx.jsx("p", { className: "dwm-hint", "data-tone": imported.tone, children: imported.message }, "in-msg"),
        jsx.jsx("p", { className: "dwm-note", children: t(
          "配对是单向的：要让两台机器互相调用，两边各生成一个链接、各导入一次。导入后立即生效，不需要重启。",
          "Pairing is one-directional: for calls both ways, create a link on each side and import once on the other. Import applies immediately, no restart."
        ) })
      ] });
    }

    /**
     * Parameter value from the query string or the fragment, or "" when absent.
     *
     * Pairing links carry it in the fragment: the web UI answers a `/?token=`
     * request with a redirect to `/`, which drops the query but keeps the hash.
     */
    function readParam(name) {
      try {
        var fromQuery = new URLSearchParams(window.location.search).get(name);
        if (fromQuery) return fromQuery;
        var hash = (window.location.hash || "").replace(/^#/, "");
        if (hash === "") return "";
        return new URLSearchParams(hash).get(name) || "";
      } catch (error) {
        return "";
      }
    }

    /**
     * Claim a pairing link opened on this machine.
     *
     * The link is addressed at the other machine's origin but opened here; the
     * payload is what matters, so the page posts it and then strips the
     * parameter — leaving it in the address bar would re-pair on every reload.
     */
    function claimPairingLink() {
      var token = readParam(PAIR_PARAM);
      if (token === "") return;
      var clean = function (paired) {
        try {
          var url = new URL(window.location.href);
          url.searchParams.delete(PAIR_PARAM);
          var hash = new URLSearchParams((url.hash || "").replace(/^#/, ""));
          hash.delete(PAIR_PARAM);
          url.hash = hash.toString();
          if (paired) url.searchParams.set("paired", paired);
          window.history.replaceState(null, "", url.toString());
        } catch (error) {
          // A browser that refuses replaceState keeps a harmless fragment.
        }
      };
      fetch(PAIR_PATH, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ link: token })
      })
        .then(function (response) { return response.json(); })
        .then(function (data) {
          if (data && data.ok === true) {
            console.info("[mesh] paired with " + data.peer.nodeId);
            clean(data.peer.nodeId);
            return;
          }
          console.warn("[mesh] pairing refused: " + String((data && data.error) || "unknown"));
          clean("failed");
        })
        .catch(function (error) {
          console.warn("[mesh] pairing failed: " + String((error && error.message) || error));
          clean("failed");
        });
    }

    /**
     * Claim a domain-join link opened on this machine.
     *
     * One link from the hub machine is the whole setup: the payload carries the
     * hub's URL and the shared secret, the host writes both and starts the
     * agent, and the node registers itself on its first poll.
     */
    function claimHubLink() {
      var token = readParam(HUB_PARAM);
      if (token === "") return;
      var clean = function (joined) {
        try {
          var url = new URL(window.location.href);
          url.searchParams.delete(HUB_PARAM);
          var hash = new URLSearchParams((url.hash || "").replace(/^#/, ""));
          hash.delete(HUB_PARAM);
          url.hash = hash.toString();
          if (joined) url.searchParams.set("hub", joined);
          window.history.replaceState(null, "", url.toString());
        } catch (error) {
          // A browser that refuses replaceState keeps a harmless fragment.
        }
      };
      fetch(HUB_ADOPT_PATH, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ link: token })
      })
        .then(function (response) { return response.json(); })
        .then(function (data) {
          if (data && data.ok === true) {
            console.info("[mesh] joined hub " + data.hub.url);
            clean(data.hub.url);
            return;
          }
          console.warn("[mesh] hub join refused: " + String((data && data.error) || "unknown"));
          clean("failed");
        })
        .catch(function (error) {
          console.warn("[mesh] hub join failed: " + String((error && error.message) || error));
          clean("failed");
        });
    }

    function apply(ctx) {
      claimPairingLink();
      claimHubLink();
      // One surface only: the settings section. The rail entry, the standalone
      // page and the plugin-detail card were three doors to the same snapshot;
      // the mesh is configuration, and configuration lives in settings.
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
export { apply, inject };
