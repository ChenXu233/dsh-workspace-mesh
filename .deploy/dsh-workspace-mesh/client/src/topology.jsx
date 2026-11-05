import * as React from "react";
import * as jsx from "react/jsx-runtime";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  applyNodeChanges
} from "@xyflow/react";
import flowCss from "@xyflow/react/dist/style.css";
import { buildGraph } from "../../src/graph/model";
import { createForceLayout, radiusOf } from "../../src/graph/layout";

/**
 * Interactive topology canvas.
 *
 * React Flow owns the interaction (drag, pan, wheel zoom, fit view); the layout
 * is our own deterministic force solver from src/graph/layout.ts, so positions
 * are computed from the roster instead of hand-placed, and the same payload
 * always settles the same way.
 */

var CANVAS_WIDTH = 720;
var CANVAS_HEIGHT = 320;
var PIN_PREFIX = "dsh.mesh.topology.v4:";

/** Stable, short key for "this graph shape" so pins survive a refresh but not a roster change. */
function signatureOf(graph) {
  var text = graph.nodes.map(function (node) { return node.id; }).sort().join("|");
  var hash = 2166136261;
  for (var i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function readStore(key) {
  try {
    if (typeof localStorage === "undefined") return {};
    var raw = localStorage.getItem(key);
    if (!raw) return {};
    var parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    return {};
  }
}

function writeStore(key, value) {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    /* storage can be full or disabled; the graph still works */
  }
}

/**
 * Pick the side of a node its label collides with least. Positions are already
 * final when this runs, so a cheap scoring pass beats a fixed rule that collides
 * with the child sitting under the parent.
 */
function pickLabelSide(node, everyone) {
  var width = Math.min(140, Math.max(30, String(node.label).length * 7));
  var height = 15;
  var gap = (node.radius || 8) + 5;
  var candidates = [
    { side: "top", dx: 0, dy: -gap - height / 2 },
    { side: "bottom", dx: 0, dy: gap + height / 2 },
    { side: "right", dx: gap + width / 2, dy: 0 },
    { side: "left", dx: -gap - width / 2, dy: 0 }
  ];
  var best = "bottom";
  var bestScore = Infinity;
  for (var index = 0; index < candidates.length; index += 1) {
    var candidate = candidates[index];
    var centerX = node.x + candidate.dx;
    var centerY = node.y + candidate.dy;
    var score = 0;
    // A label that leaves the canvas is worse than one that touches a node.
    if (centerX - width / 2 < 4 || centerX + width / 2 > CANVAS_WIDTH - 4) score += 40;
    if (centerY - height / 2 < 4 || centerY + height / 2 > CANVAS_HEIGHT - 4) score += 40;
    for (var other = 0; other < everyone.length; other += 1) {
      var peer = everyone[other];
      if (peer.id === node.id) continue;
      var limitX = width / 2 + (peer.radius || 8) + 2;
      var limitY = height / 2 + (peer.radius || 8) + 2;
      var dx = Math.abs(peer.x - centerX);
      var dy = Math.abs(peer.y - centerY);
      if (dx < limitX && dy < limitY) score += 1 + (limitX - dx) / limitX;
    }
    if (score < bestScore) {
      bestScore = score;
      best = candidate.side;
    }
    if (score === 0) return candidate.side;
  }
  return best;
}

/** The library positions handles by side; these pins put them on the dot centre instead. */
var CENTRE_PIN = {
  top: "50%",
  left: "50%",
  right: "auto",
  bottom: "auto",
  width: "1px",
  height: "1px",
  minWidth: 0,
  minHeight: 0,
  border: 0,
  background: "transparent",
  opacity: 0,
  transform: "translate(-50%, -50%)",
  pointerEvents: "none"
};

/** Shape of a node: fill and stroke by layer and liveness. */
function nodePaint(kind, status) {
  if (kind === "self") return { fill: "var(--dsw-alias-state-business-primary,#4c8dff)", stroke: "none", width: 0 };
  if (kind === "peer" && status === "online") return { fill: "var(--dsw-alias-state-success,#3fb950)", stroke: "none", width: 0 };
  if (kind === "peer" && status === "offline") return { fill: "none", stroke: "var(--dsw-alias-state-danger,#f85149)", width: 1.2 };
  if (kind === "peer") return { fill: "none", stroke: "var(--dsw-alias-label-tertiary,#8b8b93)", width: 1.2 };
  return { fill: "var(--dsw-alias-label-tertiary,#8b8b93)", stroke: "none", width: 0 };
}

/** Everyone's current spot, for the label collision pass. */
function placedFor(graph, positions) {
  var out = [];
  for (var index = 0; index < graph.nodes.length; index += 1) {
    var node = graph.nodes[index];
    var point = positions[node.id];
    if (point === undefined) continue;
    out.push({ id: node.id, x: point.x, y: point.y, radius: radiusOf(node.kind), label: node.label });
  }
  return out;
}

/** One node: a real circle (SVG, so nothing can round it into a square) plus a label. */
function TopoGraphNode(props) {
  var data = props.data;
  var radius = data.radius;
  var paint = nodePaint(data.kind, data.status);
  var box = radius * 2;
  return jsx.jsxs("div", {
    className: "dwm-topon",
    "data-kind": data.kind,
    "data-status": data.status,
    "data-dim": data.dimmed ? "1" : "0",
    "data-active": data.active ? "1" : "0",
    "data-labelpos": data.labelSide,
    style: { width: box, height: box },
    children: [
      jsx.jsx("svg", {
        className: "dwm-topon-dot",
        width: box,
        height: box,
        viewBox: "0 0 " + box + " " + box,
        "aria-hidden": "true",
        children: jsx.jsx("circle", {
          cx: radius,
          cy: radius,
          r: Math.max(radius - 0.75, 1.2),
          fill: paint.fill,
          stroke: paint.stroke,
          strokeWidth: paint.width,
          opacity: data.kind === "workspace" ? 0.8 : data.kind === "task" ? 0.55 : 1
        })
      }),
      data.showLabel === false ? null : jsx.jsx("span", { className: "dwm-topon-label", children: data.label }),
      jsx.jsx(Handle, { type: "target", position: Position.Top, className: "dwm-topon-handle", style: CENTRE_PIN }),
      jsx.jsx(Handle, { type: "source", position: Position.Bottom, className: "dwm-topon-handle", style: CENTRE_PIN })
    ]
  });
}

var NODE_TYPES = { mesh: TopoGraphNode };

/**
 * A canvas failure must not blank the whole settings card: keep the message on
 * screen with a retry, because a blank panel is what "it silently did nothing"
 * looks like.
 */
export class TopoBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: "" };
    this.retry = this.retry.bind(this);
  }
  static getDerivedStateFromError(error) {
    return { error: String((error && error.message) || error) };
  }
  retry() {
    this.setState({ error: "" });
  }
  render() {
    if (this.state.error !== "") {
      var t = this.props.t;
      return jsx.jsxs("div", { className: "dwm-topo-fallback", children: [
        jsx.jsx("p", { className: "dwm-note", "data-tone": "warn", children: (t ? t("拓扑画布渲染失败：", "Topology canvas failed: ") : "") + this.state.error }),
        jsx.jsx("button", { className: "dwm-ghost", type: "button", onClick: this.retry, children: t ? t("重试", "retry") : "retry" })
      ] });
    }
    return this.props.children;
  }
}

function TopologyCanvas(props) {
  var graph = props.graph;
  var signature = props.signature;
  var t = props.t;
  var showTasks = props.showTasks;
  var onToggleTasks = props.onToggleTasks;
  var storeKey = PIN_PREFIX + signature;

  var initial = React.useMemo(function () { return readStore(storeKey); }, [storeKey]);
  var [positions, setPositions] = React.useState({});
  var [active, setActive] = React.useState(null);
  var [dimmed, setDimmed] = React.useState({});
  var [selected, setSelected] = React.useState(null);
  var [settling, setSettling] = React.useState(true);

  var layoutRef = React.useRef(null);
  var frameRef = React.useRef(0);
  var runningRef = React.useRef(false);
  var lastStepRef = React.useRef(0);
  var draggingRef = React.useRef(false);
  var pinsRef = React.useRef({});
  var viewportRef = React.useRef(initial.viewport && typeof initial.viewport === "object" ? initial.viewport : null);
  var flowRef = React.useRef(null);
  var fittedRef = React.useRef(false);
  var settlingRef = React.useRef(true);

  var persist = React.useCallback(function () {
    writeStore(storeKey, { pins: pinsRef.current, viewport: viewportRef.current });
  }, [storeKey]);

  // One long-lived simulation per graph shape: dragging must not rebuild it,
  // otherwise every drop snaps the whole picture to a freshly seeded layout.
  var ensureLoop = React.useCallback(function () {
    if (runningRef.current === true) return;
    runningRef.current = true;
    var tick = function (now) {
      var layout = layoutRef.current;
      if (layout === null) { runningRef.current = false; return; }
      if (now - lastStepRef.current >= 32) {
        layout.step();
        setPositions(layout.positions());
        lastStepRef.current = now;
      }
      if (layout.settled() && draggingRef.current !== true) {
        runningRef.current = false;
        settlingRef.current = false;
        setSettling(false);
        if (flowRef.current && !fittedRef.current) {
          fittedRef.current = true;
          if (viewportRef.current === null) flowRef.current.fitView({ padding: 0.14, maxZoom: 1.05, duration: 240 });
        }
        return;
      }
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
  }, []);

  /** Keep the simulation warm so the rest of the graph answers the pointer. */
  var stir = React.useCallback(function (strength) {
    var layout = layoutRef.current;
    if (layout !== null) layout.alpha = Math.max(layout.alpha, strength);
    ensureLoop();
  }, [ensureLoop]);

  React.useEffect(function () {
    var layout = createForceLayout(graph, { width: CANVAS_WIDTH, height: CANVAS_HEIGHT });
    layoutRef.current = layout;
    setPositions(layout.positions());
    fittedRef.current = false;
    settlingRef.current = true;
    setSettling(true);
    ensureLoop();
    return function () {
      if (frameRef.current !== 0) cancelAnimationFrame(frameRef.current);
      runningRef.current = false;
      layoutRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, ensureLoop]);

  var neighbours = React.useMemo(function () {
    var map = {};
    for (var i = 0; i < graph.edges.length; i += 1) {
      var edge = graph.edges[i];
      (map[edge.from] = map[edge.from] || {})[edge.to] = true;
      (map[edge.to] = map[edge.to] || {})[edge.from] = true;
    }
    return map;
  }, [graph]);

  function focusNode(id) {
    setActive(id);
    if (id === null) { setDimmed({}); return; }
    var next = {};
    var linked = neighbours[id] || {};
    for (var i = 0; i < graph.nodes.length; i += 1) {
      var nodeId = graph.nodes[i].id;
      if (nodeId !== id && linked[nodeId] !== true) next[nodeId] = true;
    }
    setDimmed(next);
  }

  var [nodes, setNodes] = React.useState([]);
  React.useEffect(function () {
    setNodes(function (previous) {
      var byId = {};
      for (var index = 0; index < previous.length; index += 1) byId[previous[index].id] = previous[index];
      return graph.nodes.map(function (node) {
        var point = positions[node.id] || { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2 };
        var here = { id: node.id, x: point.x, y: point.y, radius: radiusOf(node.kind), label: node.label };
        var existing = byId[node.id];
        // A node the pointer is holding belongs to React Flow until the drag ends,
        // otherwise the next render snaps it back under the cursor.
        var position = existing !== undefined && existing.dragging === true ? existing.position : { x: point.x, y: point.y };
        return {
          id: node.id,
          type: "mesh",
          position: position,
          dragging: existing !== undefined && existing.dragging === true,
          draggable: true,
          selectable: false,
          connectable: false,
          data: {
            kind: node.kind,
            label: node.label,
            status: node.status,
            radius: radiusOf(node.kind),
            dimmed: dimmed[node.id] === true,
            active: active === node.id || selected === node.id,
            labelSide: node.kind === "self" ? "bottom" : pickLabelSide(here, placedFor(graph, positions)),
            showLabel: node.kind !== "task" || active === node.id || selected === node.id
          }
        };
      });
    });
  }, [graph, positions, dimmed, active, selected]);

  var onNodesChange = React.useCallback(function (changes) {
    setNodes(function (previous) { return applyNodeChanges(changes, previous); });
  }, []);

  var edges = React.useMemo(function () {
    return graph.edges.map(function (edge) {
      var touch = active === null ? true : (active === edge.from || active === edge.to);
      var hub = edge.kind === "hub";
      return {
        id: edge.id,
        source: edge.from,
        target: edge.to,
        type: "straight",
        selectable: false,
        focusable: false,
        style: {
          stroke: edge.tone === "offline" ? "var(--dsw-alias-state-danger, #f85149)" : "var(--dsw-alias-label-tertiary, #8b8b93)",
          strokeWidth: hub ? 1.1 : 1,
          strokeDasharray: edge.dashed ? "2 3" : undefined,
          strokeLinecap: "round",
          opacity: touch ? (edge.dashed ? 0.45 : 0.62) : 0.1
        }
      };
    });
  }, [graph, active]);

  var selectedNode = selected === null ? null : graph.nodes.filter(function (node) { return node.id === selected; })[0];

  function handleDragStart() {
    draggingRef.current = true;
    stir(0.6);
  }

  function handleDrag(event, node) {
    if (layoutRef.current === null) return;
    layoutRef.current.pin(node.id, node.position.x, node.position.y);
    stir(0.55);
  }

  function handleDragStop() {
    var layout = layoutRef.current;
    if (layout === null) return;
    draggingRef.current = false;
    // Let go means let go: the node keeps moving under the same forces, so a
    // previous drag never freezes part of the graph.
    layout.releaseAll();
    persist();
    stir(0.5);
  }

  function relayout() {
    if (layoutRef.current === null) return;
    layoutRef.current.releaseAll();
    pinsRef.current = {};
    viewportRef.current = null;
    fittedRef.current = false;
    persist();
    stir(0.9);
  }

  return jsx.jsxs("div", { className: "dwm-topo-canvas", children: [
    jsx.jsx(ReactFlow, {
      nodes: nodes,
      onNodesChange: onNodesChange,
      edges: edges,
      nodeTypes: NODE_TYPES,
      nodeOrigin: [0.5, 0.5],
      fitView: true,
      fitViewOptions: { padding: 0.14, maxZoom: 1.05 },
      minZoom: 0.4,
      maxZoom: 1.8,
      nodesDraggable: true,
      nodesConnectable: false,
      elementsSelectable: false,
      panOnScroll: false,
      proOptions: { hideAttribution: true },
      onInit: function (instance) { flowRef.current = instance; },
      onMoveEnd: function (event, viewport) {
        // Only a user gesture is worth remembering: fitView passes no event, and
        // a saved programmatic view freezes the graph off-centre next time.
        if (event === null || event === undefined) return;
        if (settlingRef.current) return;
        viewportRef.current = viewport;
        persist();
      },
      onNodeMouseEnter: function (event, node) { focusNode(node.id); },
      onNodeMouseLeave: function () { focusNode(null); },
      onNodeClick: function (event, node) { setSelected(node.id); },
      onNodeDragStart: handleDragStart,
      onNodeDrag: handleDrag,
      onNodeDragStop: handleDragStop,
      onPaneClick: function () { setSelected(null); focusNode(null); },
      children: [
        jsx.jsx(Background, { variant: BackgroundVariant.Dots, gap: 24, size: 1, color: "var(--dsw-alias-border-l2, #3a3a44)" }),
        jsx.jsx(Controls, { position: "bottom-right", showInteractive: false })
      ]
    }),
    jsx.jsx("div", { className: "dwm-topo-legend", children: [
      jsx.jsx("span", { className: "dwm-topo-key", "data-tone": "self", children: t("本机", "this node") }),
      jsx.jsx("span", { className: "dwm-topo-key", "data-tone": "online", children: t("在线", "online") }),
      jsx.jsx("span", { className: "dwm-topo-key", "data-tone": "unknown", children: t("未知", "unknown") }),
      jsx.jsx("span", { className: "dwm-topo-key", "data-tone": "offline", children: t("离线", "offline") })
    ] }),
    jsx.jsxs("div", { className: "dwm-topo-toolbar", children: [
      jsx.jsx("button", {
        type: "button",
        className: "dwm-topo-tool",
        "data-on": showTasks ? "1" : "0",
        onClick: onToggleTasks,
        children: t("任务层", "tasks")
      }),
      jsx.jsx("button", {
        type: "button",
        className: "dwm-topo-tool",
        onClick: relayout,
        title: t("重新升温并重排整张图", "warm the simulation up and lay the graph out again"),
        children: t("重置布局", "relayout")
      })
    ] }),
    settling ? jsx.jsx("div", { className: "dwm-topo-settling", children: t("布局计算中…", "laying out…") }) : null,
    selectedNode === null ? null : jsx.jsxs("div", { className: "dwm-topo-inspector", children: [
      jsx.jsxs("div", { className: "dwm-topo-inspector-head", children: [
        jsx.jsx("span", { className: "dwm-topo-inspector-dot", "data-tone": selectedNode.status, "data-kind": selectedNode.kind }),
        jsx.jsx("strong", { children: selectedNode.label }),
        jsx.jsx("span", { className: "dwm-topo-inspector-kind", children: selectedNode.kind + " · " + selectedNode.status })
      ] }),
      selectedNode.sublabel === "" ? null : jsx.jsx("div", { className: "dwm-topo-inspector-sub", children: selectedNode.sublabel }),
      selectedNode.detail.length === 0 ? null : jsx.jsx("dl", { className: "dwm-topo-inspector-rows", children: selectedNode.detail.map(function (row) {
        return jsx.jsxs("div", { children: [
          jsx.jsx("dt", { children: row[0] }),
          jsx.jsx("dd", { children: row[1] })
        ] }, row[0]);
      }) })
    ] })
  ] });
}

/** Settings card: header, canvas, and the honesty notes under it. */
export function MeshTopology(props) {
  var t = props.t;
  var peers = props.peers || [];
  var tasks = props.tasks || [];
  var selfLabel = props.selfLabel;
  var layerState = React.useState(true);
  var showTasks = layerState[0];
  var setShowTasks = layerState[1];

  var graph = React.useMemo(function () {
    return buildGraph(
      { peers: peers, tasks: showTasks ? tasks : [] },
      { selfLabel: selfLabel }
    );
  }, [peers, tasks, selfLabel, showTasks]);

  var signature = React.useMemo(function () { return signatureOf(graph); }, [graph]);
  var empty = graph.nodes.length <= 1;

  return jsx.jsxs("div", { className: "dwm-form", children: [
    jsx.jsxs("div", { className: "dwm-topo-head", children: [
      jsx.jsx("h3", { className: "dwm-h3", children: t("互联拓扑", "Connectivity topology") }),
      empty ? null : jsx.jsx("span", { className: "dwm-topo-count", children: t(
        (graph.nodes.length - 1) + " 个节点 · " + graph.edges.length + " 条连接",
        (graph.nodes.length - 1) + " nodes · " + graph.edges.length + " links"
      ) })
    ] }),
    empty
      ? jsx.jsx("p", { className: "dwm-empty", children: t("还没有可绘制的节点。", "No peers to draw yet.") })
      : jsx.jsx(TopoBoundary, { t: t, children: jsx.jsx(TopologyCanvas, {
        graph: graph,
        signature: signature,
        t: t,
        showTasks: showTasks,
        onToggleTasks: function () { setShowTasks(!showTasks); }
      }) }),
    empty ? null : jsx.jsx("p", { className: "dwm-note", children: t(
      "位置由力导向布局算出，不是手工摆的：本机居中，对端在外圈，工作区挂在其所属对端下，进行中的任务再外一层。拖动一个节点时它会带着周围一起动，松手后整张图继续按受力收敛；滚轮缩放，空白处拖动平移。",
      "Positions come from a force layout, not hand-placed rows: this node in the middle, peers on a ring, workspaces under their owner, live tasks one layer out. Dragging one node pulls its neighbours with it, and the graph keeps settling after you let go; wheel to zoom, drag the blank area to pan."
    ) }),
    graph.orphanTasks > 0 ? jsx.jsx("p", { className: "dwm-note", "data-tone": "warn", children: t(
      "另有 " + graph.orphanTasks + " 个进行中任务的目标不在当前 roster 里，图上不画（不伪造节点）。",
      graph.orphanTasks + " live task(s) target a node outside the roster; they are counted, not drawn as invented nodes."
    ) }) : null
  ] });
}

/** Styles for the canvas; appended to the plugin stylesheet by app.js. */
export var TOPOLOGY_CSS =
  ".dwm-topo-head{display:flex;align-items:baseline;gap:10px}" +
  ".dwm-topo-count{font-size:12px;color:var(--dsw-alias-label-tertiary);margin-left:auto}" +
  ".dwm-topo-canvas{position:relative;width:100%;height:320px;border-radius:8px;overflow:hidden;border:.5px solid var(--dsw-alias-border-l2);background:transparent}" +
  ".dwm-topo-canvas .react-flow{background:transparent}" +
  ".dwm-topo-canvas .react-flow__background{opacity:.45}" +
  ".dwm-topo-canvas .react-flow__attribution{display:none}" +
  ".dwm-topo-canvas .react-flow__node{font:inherit}" +
  ".dwm-topon{position:relative;display:flex;align-items:center;justify-content:center;cursor:grab;transition:opacity .12s ease}" +
  // the dot is 6–22px wide; the halo is what the pointer actually grabs
  ".dwm-topon:before{content:\"\";position:absolute;inset:-9px;border-radius:50%}" +
  ".dwm-topon[data-dim=1]{opacity:.25}" +
  ".dwm-topon-dot{display:block;overflow:visible;transition:transform .12s ease}" +
  ".dwm-topon-label{position:absolute;white-space:nowrap;pointer-events:none;font-size:11px;line-height:15px;" +
  "color:var(--dsw-alias-label-secondary,#c3c3ca);text-shadow:0 1px 2px rgba(0,0,0,.55);max-width:140px;overflow:hidden;text-overflow:ellipsis}" +
  ".dwm-topon[data-labelpos=right] .dwm-topon-label{left:100%;margin-left:8px;top:50%;transform:translateY(-50%)}" +
  ".dwm-topon[data-labelpos=left] .dwm-topon-label{right:100%;margin-right:8px;top:50%;transform:translateY(-50%);text-align:right}" +
  ".dwm-topon[data-labelpos=top] .dwm-topon-label{bottom:100%;margin-bottom:6px;left:50%;transform:translateX(-50%)}" +
  ".dwm-topon[data-labelpos=bottom] .dwm-topon-label{top:100%;margin-top:6px;left:50%;transform:translateX(-50%)}" +
  ".dwm-topon[data-kind=self] .dwm-topon-label,.dwm-topon[data-kind=peer] .dwm-topon-label{color:var(--dsw-alias-label-primary,#e9e9ec)}" +
  ".dwm-topon[data-kind=workspace] .dwm-topon-label,.dwm-topon[data-kind=task] .dwm-topon-label{font-size:10px;color:var(--dsw-alias-label-tertiary)}" +
  ".dwm-topon[data-active=1] .dwm-topon-label{color:var(--dsw-alias-label-primary,#e9e9ec)}" +
  // Handles sit on the node centre: a link leaves from the dot, not from a side.
  ".dwm-topon-handle{position:absolute;top:50%;left:50%;width:1px;height:1px;min-width:0;min-height:0;border:0;background:transparent;opacity:0;transform:translate(-50%,-50%);pointer-events:none}" +
  ".dwm-topo-legend{position:absolute;left:10px;top:9px;display:flex;gap:12px;align-items:center;pointer-events:none;z-index:5}" +
  ".dwm-topo-key{display:inline-flex;align-items:center;gap:5px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}" +
  ".dwm-topo-key:before{content:\"\";width:5px;height:5px;border-radius:999px;background:var(--dsw-alias-label-tertiary)}" +
  ".dwm-topo-key[data-tone=self]:before{background:var(--dsw-alias-state-business-primary,#4c8dff)}" +
  ".dwm-topo-key[data-tone=online]:before{background:var(--dsw-alias-state-success,#3fb950)}" +
  ".dwm-topo-key[data-tone=offline]:before{background:var(--dsw-alias-state-danger,#f85149)}" +
  ".dwm-topo-toolbar{position:absolute;right:9px;top:8px;display:flex;gap:6px;z-index:5}" +
  ".dwm-topo-tool{font:inherit;font-size:11px;line-height:16px;padding:2px 8px;border-radius:6px;cursor:pointer;" +
  "color:var(--dsw-alias-label-tertiary);background:transparent;border:.5px solid var(--dsw-alias-border-l2);transition:color .15s ease,border-color .15s ease}" +
  ".dwm-topo-tool:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-tertiary)}" +
  ".dwm-topo-tool[data-on=1]{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-tertiary)}" +
  ".dwm-topo-settling{position:absolute;left:50%;bottom:10px;transform:translateX(-50%);font-size:11px;color:var(--dsw-alias-label-tertiary);pointer-events:none;z-index:5}" +
  ".dwm-topo-inspector{position:absolute;left:9px;bottom:9px;max-width:280px;z-index:6;display:flex;flex-direction:column;gap:3px;" +
  "padding:8px 10px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-secondary,#1b1b20)}" +
  ".dwm-topo-inspector-head{display:flex;align-items:center;gap:7px;font-size:12px}" +
  ".dwm-topo-inspector-dot{width:6px;height:6px;border-radius:999px;background:var(--dsw-alias-label-tertiary);flex:0 0 auto}" +
  ".dwm-topo-inspector-dot[data-tone=online]{background:var(--dsw-alias-state-success,#3fb950)}" +
  ".dwm-topo-inspector-dot[data-tone=offline]{background:var(--dsw-alias-state-danger,#f85149)}" +
  ".dwm-topo-inspector-dot[data-kind=self]{background:var(--dsw-alias-state-business-primary,#4c8dff)}" +
  ".dwm-topo-inspector-kind{margin-left:auto;font-size:10px;color:var(--dsw-alias-label-tertiary)}" +
  ".dwm-topo-inspector-sub{font-size:11px;color:var(--dsw-alias-label-tertiary);word-break:break-all}" +
  ".dwm-topo-inspector-rows{display:flex;flex-direction:column;gap:1px;margin:2px 0 0}" +
  ".dwm-topo-inspector-rows>div{display:flex;gap:8px;font-size:11px;line-height:16px}" +
  ".dwm-topo-inspector-rows dt{color:var(--dsw-alias-label-tertiary);min-width:62px;margin:0}" +
  ".dwm-topo-inspector-rows dd{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all}" +
  ".dwm-topo-canvas .react-flow__controls{border-radius:6px;overflow:hidden;box-shadow:none;border:.5px solid var(--dsw-alias-border-l2);background:transparent}" +
  ".dwm-topo-canvas .react-flow__controls-button{width:22px;height:22px;background:transparent;border:0;border-bottom:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}" +
  ".dwm-topo-canvas .react-flow__controls-button:hover{background:var(--dsw-alias-bg-secondary);color:var(--dsw-alias-label-primary)}" +
  ".dwm-topo-canvas .react-flow__controls-button svg{fill:currentColor;max-width:10px;max-height:10px}" +
  ".dwm-topo-fallback{display:flex;flex-direction:column;gap:8px;align-items:flex-start}";

/** Injected once per page: the vendored stylesheet that ships inside the bundle. */
export function ensureVendorCss() {
  if (typeof document === "undefined") return;
  if (document.querySelector("style[data-plugin-css='dsh-workspace-mesh/xyflow']") !== null) return;
  var tag = document.createElement("style");
  tag.dataset.plugin = "dsh-workspace-mesh";
  tag.dataset.pluginCss = "dsh-workspace-mesh/xyflow";
  tag.textContent = flowCss;
  document.head.appendChild(tag);
}
