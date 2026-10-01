import { useEffect, useMemo, useRef, useState } from "react";
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation } from "d3-force";

/**
 * Knowledge graph of the vault: one dot per note, lines = [[links]]. Notes gather around their cluster
 * (note type / top folder) placed on a ring; cluster names sit outside the ring with "N note · X% Vault".
 * Canvas (thousands of notes stay smooth); wheel = zoom, drag = pan, click a dot = open the note.
 */
export type GNode = { id: string; title: string; cluster: string; degree: number; mtime: string; x?: number; y?: number; vx?: number; vy?: number; fx?: number | null; fy?: number | null };
export type GLink = { source: string | GNode; target: string | GNode };
const PALETTE: Record<string, string> = {
  "PROJECT": "#d97706", "MARKETING & BUSINESS": "#059669", "CONVERSATIONS": "#2563eb", "WIKI": "#7c3aed", "FACTS": "#b45309", "REFERENCES": "#0891b2",
  "AGENTS": "#db2777", "NHẬT KÝ": "#ea580c", "KẾ HOẠCH": "#0d9488", "IDENTITY": "#9333ea", "LEARNING": "#16a34a", "DASHBOARD": "#dc2626", "HƯỚNG DẪN": "#64748b",
};
const EXTRA = ["#0ea5e9", "#84cc16", "#f43f5e", "#a855f7", "#14b8a6", "#f59e0b", "#6366f1", "#ec4899"];
export const clusterColor = (key: string) => PALETTE[key] ?? EXTRA[[...key].reduce((a, c) => a + c.charCodeAt(0), 0) % EXTRA.length];

export function BrainGraph({ nodes, links, clusters, onOpen, showLabels, recentHours, status }: {
  nodes: GNode[]; links: GLink[]; clusters: { key: string; count: number; pct: number }[];
  onOpen: (path: string) => void; showLabels: boolean; recentHours: number | null; status: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const view = useRef({ k: 1, x: 0, y: 0 });
  const hover = useRef<GNode | null>(null);
  const sim = useRef<Simulation<GNode, undefined> | null>(null);
  const [, force] = useState(0);
  const draw = useRef<() => void>(() => {});

  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.max(200, e.contentRect.width), h: Math.max(200, e.contentRect.height) }));
    if (wrap.current) ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  // Cluster anchors on an ellipse that leaves the bottom free (status + stats card live there).
  // Biggest cluster on top, the others alternate left/right so neighbours' labels don't collide.
  const anchors = useMemo(() => {
    const m = new Map<string, { x: number; y: number; ax: number; ay: number }>();
    const n = clusters.length;
    const rx = Math.min(size.w * 0.3, 520), ry = Math.min(size.h * 0.3, 280);
    const span = (290 * Math.PI) / 180; // degrees covered, gap at the bottom
    const order = clusters.map((_, i) => (i === 0 ? 0 : i % 2 ? Math.ceil(i / 2) : -Math.ceil(i / 2)));
    const half = Math.max(1, Math.ceil((n - 1) / 2));
    clusters.forEach((c, i) => {
      const a = -Math.PI / 2 + (n > 1 ? (order[i] / half) * (span / 2) : 0);
      // Labels stay inside the canvas even when it is narrow (e.g. Ngân Nguyệt docked beside it)
      const lim = Math.max(40, size.w / 2 - 12 - Math.min(150, c.key.length * 6.5));
      m.set(c.key, { x: Math.cos(a) * rx * 0.6, y: Math.sin(a) * ry * 0.6, ax: Math.max(-lim, Math.min(lim, Math.cos(a) * (rx + 90))), ay: Math.sin(a) * (ry + 40) - 8 });
    });
    return m;
  }, [clusters, size.w, size.h]);

  // Simulation (re-run when the graph changes; positions are kept for notes already on screen)
  const nodesRef = useRef<GNode[]>([]);
  useEffect(() => {
    const prev = new Map(nodesRef.current.map((n) => [n.id, n]));
    const ns = nodes.map((n) => {
      const p = prev.get(n.id);
      const a = anchors.get(n.cluster);
      return { ...n, x: p?.x ?? (a?.x ?? 0) + (Math.random() - 0.5) * 60, y: p?.y ?? (a?.y ?? 0) + (Math.random() - 0.5) * 60 };
    });
    nodesRef.current = ns;
    const ids = new Set(ns.map((n) => n.id));
    const ls = links.filter((l) => ids.has(String((l.source as any).id ?? l.source)) && ids.has(String((l.target as any).id ?? l.target))).map((l) => ({ source: String((l.source as any).id ?? l.source), target: String((l.target as any).id ?? l.target) }));
    sim.current?.stop();
    const s = forceSimulation<GNode>(ns)
      .force("link", forceLink<GNode, any>(ls).id((d) => d.id).distance(26).strength(0.04))
      .force("charge", forceManyBody<GNode>().strength(-14).distanceMax(220))
      .force("x", forceX<GNode>((d) => anchors.get(d.cluster)?.x ?? 0).strength(0.07))
      .force("y", forceY<GNode>((d) => anchors.get(d.cluster)?.y ?? 0).strength(0.07))
      .force("collide", forceCollide<GNode>((d) => 2.5 + Math.sqrt(d.degree)))
      .alpha(prev.size ? 0.4 : 1).alphaDecay(0.03)
      .on("tick", () => draw.current());
    (s as any).__links = ls;
    sim.current = s;
    return () => { s.stop(); };
  }, [nodes, links, anchors]);

  // Drawing
  draw.current = () => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== size.w * dpr) { c.width = size.w * dpr; c.height = size.h * dpr; }
    const ctx = c.getContext("2d")!;
    const css = getComputedStyle(document.documentElement);
    const ink = css.getPropertyValue("--ink").trim() || "#1f2937";
    const muted = css.getPropertyValue("--muted").trim() || "#6b7280";
    const dark = document.documentElement.classList.contains("dark");
    const { k, x: tx, y: ty } = view.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    ctx.translate(size.w / 2 + tx, size.h / 2 + ty);
    ctx.scale(k, k);
    const h = hover.current;
    const neighbors = new Set<string>();
    const ls = ((sim.current as any)?.__links ?? []) as { source: GNode; target: GNode }[];
    if (h) for (const l of ls) { if (l.source.id === h.id) neighbors.add(l.target.id); if (l.target.id === h.id) neighbors.add(l.source.id); }
    // links
    ctx.lineWidth = 0.6 / k;
    for (const l of ls) {
      if (l.source.x == null || l.target.x == null) continue;
      const on = h && (l.source.id === h.id || l.target.id === h.id);
      ctx.strokeStyle = on ? (dark ? "rgba(196,181,253,0.9)" : "rgba(124,58,237,0.75)") : dark ? "rgba(167,139,250,0.10)" : "rgba(124,58,237,0.10)";
      ctx.beginPath(); ctx.moveTo(l.source.x, l.source.y!); ctx.lineTo(l.target.x, l.target.y!); ctx.stroke();
    }
    // nodes
    const recentCut = recentHours ? Date.now() - recentHours * 3600_000 : null;
    for (const n of nodesRef.current) {
      if (n.x == null) continue;
      const r = 1.8 + Math.sqrt(n.degree) * 0.9;
      const recent = recentCut && new Date(n.mtime).getTime() > recentCut;
      ctx.globalAlpha = h && n.id !== h.id && !neighbors.has(n.id) ? 0.25 : recentCut && !recent ? 0.35 : 1;
      ctx.fillStyle = clusterColor(n.cluster);
      ctx.beginPath(); ctx.arc(n.x, n.y!, n.id === h?.id ? r + 2 : r, 0, Math.PI * 2); ctx.fill();
      if (recent) { ctx.strokeStyle = "#f97316"; ctx.lineWidth = 1.2 / k; ctx.beginPath(); ctx.arc(n.x, n.y!, r + 2.5, 0, Math.PI * 2); ctx.stroke(); }
      if ((showLabels && k > 1.6) || n.id === h?.id || (h && neighbors.has(n.id) && k > 0.9)) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = ink;
        ctx.font = `${(n.id === h?.id ? 12 : 10) / k}px "Be Vietnam Pro", system-ui`;
        ctx.fillText(n.title.slice(0, 48), n.x + r + 3, n.y! + 3 / k);
      }
    }
    ctx.globalAlpha = 1;
    // cluster labels (outside the ring)
    if (showLabels) {
      for (const cl of clusters) {
        const a = anchors.get(cl.key);
        if (!a) continue;
        ctx.textAlign = "center";
        ctx.fillStyle = ink;
        ctx.font = `600 ${15 / k}px "Be Vietnam Pro", system-ui`;
        (ctx as any).letterSpacing = `${3 / k}px`;
        ctx.fillText(cl.key, a.ax, a.ay);
        (ctx as any).letterSpacing = "0px";
        ctx.font = `${11.5 / k}px "Be Vietnam Pro", system-ui`;
        ctx.fillStyle = muted;
        const t1 = `${cl.count} note · `, t2 = `${cl.pct}% Vault`;
        const w1 = ctx.measureText(t1).width, w2 = ctx.measureText(t2).width;
        ctx.textAlign = "left";
        ctx.fillText(t1, a.ax - (w1 + w2) / 2, a.ay + 18 / k);
        ctx.fillStyle = clusterColor(cl.key);
        ctx.fillText(t2, a.ax - (w1 + w2) / 2 + w1, a.ay + 18 / k);
      }
    }
    ctx.textAlign = "center";
    ctx.fillStyle = muted;
    ctx.font = `500 ${14 / k}px "Be Vietnam Pro", system-ui`;
    (ctx as any).letterSpacing = `${5 / k}px`;
    ctx.fillText(status, 0, Math.min(size.h * 0.3, 280) * 0.6 + 70);
    (ctx as any).letterSpacing = "0px";
    ctx.textAlign = "left";
  };
  useEffect(() => { draw.current(); }, [size, showLabels, recentHours, clusters, status]);

  // Interaction
  const toWorld = (cx: number, cy: number) => {
    const r = canvas.current!.getBoundingClientRect();
    const { k, x, y } = view.current;
    return { x: (cx - r.left - size.w / 2 - x) / k, y: (cy - r.top - size.h / 2 - y) / k };
  };
  const pick = (cx: number, cy: number) => {
    const p = toWorld(cx, cy);
    let best: GNode | null = null, bd = (8 / view.current.k) ** 2;
    for (const n of nodesRef.current) {
      if (n.x == null) continue;
      const d = (n.x - p.x) ** 2 + (n.y! - p.y) ** 2;
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  };
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  return (
    <div ref={wrap} className="absolute inset-0">
      <canvas
        ref={canvas} style={{ width: size.w, height: size.h, cursor: hover.current ? "pointer" : drag.current ? "grabbing" : "grab" }}
        onWheel={(e) => {
          const r = canvas.current!.getBoundingClientRect();
          const v = view.current;
          const k2 = Math.min(6, Math.max(0.25, v.k * (e.deltaY < 0 ? 1.12 : 0.89)));
          const mx = e.clientX - r.left - size.w / 2, my = e.clientY - r.top - size.h / 2;
          v.x = mx - ((mx - v.x) * k2) / v.k; v.y = my - ((my - v.y) * k2) / v.k; v.k = k2;
          draw.current();
        }}
        onMouseDown={(e) => { drag.current = { x: e.clientX, y: e.clientY, moved: false }; }}
        onMouseMove={(e) => {
          if (drag.current) {
            const dx = e.clientX - drag.current.x, dy = e.clientY - drag.current.y;
            if (Math.abs(dx) + Math.abs(dy) > 2) drag.current.moved = true;
            view.current.x += dx; view.current.y += dy;
            drag.current.x = e.clientX; drag.current.y = e.clientY;
            draw.current();
            return;
          }
          const n = pick(e.clientX, e.clientY);
          if (n !== hover.current) { hover.current = n; draw.current(); force((x) => x + 1); }
        }}
        onMouseUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (d && !d.moved) { const n = pick(e.clientX, e.clientY); if (n) onOpen(n.id); }
        }}
        onMouseLeave={() => { drag.current = null; if (hover.current) { hover.current = null; draw.current(); } }}
        onDoubleClick={() => { view.current = { k: 1, x: 0, y: 0 }; draw.current(); }}
      />
      {hover.current && <div className="pointer-events-none absolute left-3 top-3 max-w-sm rounded-xl border border-line bg-card/95 px-3 py-2 text-xs shadow"><p className="font-semibold text-ink">{hover.current.title}</p><p className="text-muted">{hover.current.id}</p></div>}
    </div>
  );
}
