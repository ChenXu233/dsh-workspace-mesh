window.__ModuleLoader__.load({
  id: "dsh-workspace-mesh",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var React = require("react");
    var jsx = require("react/jsx-runtime");

    // The settings namespace equals this bundle's profile entry id (cordis.patch.yml: id: mesh).
    var NS = "mesh";

    var FIELDS = [
      { key: "transport", label: "传输模式", kind: "select", options: ["auto", "pairing", "loopback"],
        hint: "auto = pairing 优先，回落 loopback（需对端 URL）；保存后立即生效" },
      { key: "peerBaseUrl", label: "对端基础 URL", kind: "text",
        hint: "loopback 传输的对端 DSH 地址，如 https://peer.example.com；留空 = 不启用" },
      { key: "assignmentFile", label: "assignment.yml 路径", kind: "text",
        hint: "相对宿主进程 cwd（容器内为 /data/workspace）；留空 = 不加载" },
      { key: "leaseMs", label: "任务租约时长 (ms)", kind: "number", hint: "默认 900000" },
      { key: "dispatchTimeoutMs", label: "dispatch 超时 (ms)", kind: "number", hint: "默认 120000" },
      { key: "leaseOwner", label: "租约归属者", kind: "text", hint: "默认 mesh-lead" }
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
      ".dwm-status[data-tone=warn]{color:var(--dsw-alias-label-tertiary)}";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css='dsh-workspace-mesh/config']") === null) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-workspace-mesh";
      tag.dataset.pluginCss = "dsh-workspace-mesh/config";
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    /** Required services (cordis fiber inject on the browser half). */
    var inject = ["slots", "remote.settings"];

    function ConfigSection(props) {
      var ctx = props.ctx;
      var subject = props.subject;
      if (!subject || subject.kind !== "bundle" || subject.pkg !== "dsh-workspace-mesh") return null;
      var st = React.useState({ phase: "loading", values: {}, revision: undefined, dirty: {}, message: "", tone: "warn" });
      var state = st[0], set = st[1];
      var load = React.useCallback(function () {
        ctx.remote.settings.describe().then(function (doc) {
          var nsList = (doc && doc.namespaces) || [];
          var ns = null;
          for (var i = 0; i < nsList.length; i++) if (nsList[i].ns === NS) ns = nsList[i];
          if (!ns) { set({ phase: "missing", values: {}, revision: undefined, dirty: {}, message: "", tone: "warn" }); return; }
          set({ phase: "ready", values: ns.value || {}, revision: ns.revision, dirty: {}, message: "", tone: "warn" });
        }).catch(function (err) {
          set({ phase: "error", values: {}, revision: undefined, dirty: {}, message: String((err && err.message) || err), tone: "err" });
        });
      }, [ctx]);
      React.useEffect(function () { load(); }, [load]);
      if (state.phase === "loading") return jsx.jsx("p", { className: "dwm-status", "data-tone": "warn", children: "正在读取 mesh 配置…" });
      if (state.phase === "missing") return jsx.jsx("p", { className: "dwm-status", "data-tone": "warn", children: "设置服务未暴露 mesh 命名空间（本部署未启用 live 配置）" });
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
          ], f.key }));
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

    /**
    * Browser half of the mesh live-configuration surface: a configuration
    * section on the plugin's own detail page (plugins.detail.section), reading
    * and writing through the same native settings pipeline the shipped pages
    * use (remote.settings describe/mutate over the volatile Config schema).
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
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
