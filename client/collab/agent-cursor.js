// The agents' pointers on the canvas, one for each agent, each in its own color (ui/agent-colors.js). A pointer is anchored to the design,
// not to the screen: where it is is a place in the file, so it stays on its layer when you pan, zoom, collapse the panels or resize the window. A pointer goes to the layers
// a call is about, in the order the call names them, before the call runs, and after a call that made something it passes over
// what it made, in the order it is drawn. It glides along a curve and stays where the work is, nothing random: it fades when
// its agent is done or has been quiet for a while. Any agent over MCP gets one, the ones in the agent panel and the ones outside,
// because it follows what the agent announces (sync.js). Only the panel's agents wait for it to arrive, and only for a moment.
import { agentColor } from "../ui/agent-colors.js";

const IDLE_MS = 12000; // how long a pointer stays on the canvas when nothing new happens
const MAX_STOPS = 8; // the layers one call's tour passes over
const MIN_SIDE = 10; // a layer smaller than this is not worth stopping at
const ARRIVE_MS = 700; // the longest a call waits for its pointer to reach the first layer

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** The layers a call is about, from its arguments, in the order it names them. */
const idsOf = (args) => [...new Set([args.targetNodeId, args.nodeId, ...(args.nodeIds ?? []), ...(args.updates ?? []).flatMap((u) => u.nodeIds ?? [u.nodeId]), ...(args.nodes ?? []).map((n) => n.id), ...(args.moves ?? []).map((m) => m.nodeId)].filter((id) => typeof id === "string"))];

export function mountAgentCursor(canvas, store) {
  const layer = Object.assign(document.createElement("div"), { className: "peers" });
  canvas.append(layer);
  const pointers = new Map(); // agent name -> its pointer

  const find = (id) => canvas.querySelector(`[data-node-id="${CSS.escape(id)}"]`);
  const descendants = (element) => [...element.querySelectorAll("[data-node-id]")];
  // A place is { x, y } in the file's own pixels; the screen shows it where the pan and zoom put it.
  const toScreen = ({ x, y }) => ({ x: x * store.ui.zoom + store.ui.panX, y: y * store.ui.zoom + store.ui.panY });
  /** The middle of a layer, as a place in the file. */
  const pointOf = (element) => {
    const box = canvas.getBoundingClientRect(), r = element.getBoundingClientRect(), z = store.ui.zoom;
    return { x: (r.left - box.left + r.width / 2 - store.ui.panX) / z, y: (r.top - box.top + r.height / 2 - store.ui.panY) / z };
  };
  const hash = (name) => [...name].reduce((value, char) => (value * 31 + char.charCodeAt(0)) | 0, 0);

  function pointer(name) {
    if (pointers.has(name)) return pointers.get(name);
    const color = agentColor(name);
    const element = Object.assign(document.createElement("div"), { className: "peer-cursor agent-cursor away", style: `--peer:${color}` });
    element.innerHTML = `<svg width="14" height="18" viewBox="0 0 14 18"><path d="M1 1l11 7-5 1.5L5 16z" fill="${color}" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/></svg><span></span>`;
    element.querySelector("span").textContent = name;
    layer.append(element);
    const made = { name, element, pos: null, walk: 0, quiet: 0, aimed: null, idle: true };
    pointers.set(name, made);
    return made;
  }
  const place = (p) => { if (!p.pos) return; const at = toScreen(p.pos); p.element.style.left = `${at.x}px`; p.element.style.top = `${at.y}px`; };
  const set = (p, to) => { p.pos = to; place(p); };
  // Panning or zooming moves the file under the pointers: they follow their places.
  store.subscribe((reason) => { if (reason === "ui") pointers.forEach(place); });

  /** One glide along a curve with easing: slow, quick, slow; it takes longer the farther it goes. */
  function glide(p, to, mine, first) {
    return new Promise((resolve) => {
      const from = p.pos, dx = to.x - from.x, dy = to.y - from.y;
      const distance = Math.hypot(dx, dy) * store.ui.zoom;
      const ms = Math.min(ARRIVE_MS, 240 + distance * 0.9);
      const h = ((hash(p.name) % 18) + 18) % 18, bow = 0.08 + (h % 9) / 100, direction = h >= 9 ? 1 : -1;
      const mid = { x: (from.x + to.x) / 2 - dy * bow * direction, y: (from.y + to.y) / 2 + dx * bow * direction };
      const overshoot = distance > 400 ? 8 / store.ui.zoom : 0;
      const length = Math.hypot(dx, dy) || 1;
      const end = { x: to.x + dx / length * overshoot, y: to.y + dy / length * overshoot };
      const travelMs = ms - (overshoot ? 90 : 0);
      const start = performance.now();
      const frame = (now) => {
        if (mine !== p.walk) return resolve();
        const elapsed = now - start;
        const t = ease(Math.min(1, elapsed / travelMs)), u = 1 - t;
        set(p, { x: u * u * from.x + 2 * u * t * mid.x + t * t * end.x, y: u * u * from.y + 2 * u * t * mid.y + t * t * end.y });
        if (elapsed < travelMs) requestAnimationFrame(frame);
        else if (overshoot) {
          const settleStart = now;
          const settle = (settleNow) => {
            if (mine !== p.walk) return resolve();
            const s = Math.min(1, (settleNow - settleStart) / 90), out = 1 - Math.pow(1 - s, 2);
            set(p, { x: end.x + (to.x - end.x) * out, y: end.y + (to.y - end.y) * out });
            if (s < 1) requestAnimationFrame(settle); else resolve();
          };
          requestAnimationFrame(settle);
        } else resolve();
      };
      requestAnimationFrame(frame);
    });
  }

  /** Goes to each layer in turn and stays on the last; `arrived` is called when it is at the first. */
  async function go(p, elements, arrived) {
    const mine = ++p.walk;
    clearTimeout(p.quiet);
    const stops = elements.map(pointOf);
    const first = p.idle;
    p.idle = false;
    if (!p.pos) set(p, { x: stops[0].x - 140 / store.ui.zoom, y: stops[0].y - 90 / store.ui.zoom }); // the first time it comes in from the upper left
    p.element.classList.remove("away");
    for (const [i, stop] of stops.entries()) {
      await glide(p, stop, mine, first && i === 0);
      if (i === 0) arrived?.();
      if (mine !== p.walk) return;
      if (i < stops.length - 1) {
        const { width, height } = elements[i].getBoundingClientRect();
        await sleep(120 + Math.min(240, width * height / 4000));
      }
      if (mine !== p.walk) return;
    }
    p.quiet = setTimeout(() => { p.idle = true; p.element.classList.add("away"); }, IDLE_MS);
  }
  const leave = (p) => { p.walk++; clearTimeout(p.quiet); p.idle = true; p.element.classList.add("away"); };

  return {
    /** Before a call runs: the agent's pointer goes to the layers the call is about. Answers when it is at the first, or soon. */
    aim(name, args) {
      const p = pointer(name);
      const roots = idsOf(args ?? {}).map(find).filter(Boolean).slice(0, MAX_STOPS);
      p.aimed = roots.length ? { roots, before: new Set(roots.flatMap(descendants)) } : null;
      if (!roots.length) return Promise.resolve();
      return new Promise((resolve) => { go(p, roots, resolve); setTimeout(resolve, ARRIVE_MS + 100); });
    },
    /** What an agent announces after a call: { name, working, nodeIds }, the artboards it changed. After a call that named
     *  layers the pointer passes over what the call made inside them; after one that did not (a new artboard) it goes to
     *  the artboard. */
    follow({ name = "Agent", working, nodeIds = [] }) {
      const p = pointer(name);
      if (!working) return leave(p);
      if (p.aimed) {
        const { roots, before } = p.aimed;
        p.aimed = null;
        // The page draws what was made a moment after the call answers.
        setTimeout(() => {
          const made = roots.flatMap(descendants).filter((el) => {
            const r = el.getBoundingClientRect();
            return !before.has(el) && r.width >= MIN_SIDE && r.height >= MIN_SIDE;
          });
          // What is made first is the outer pieces, then what is inside them: the pointer follows that, and passes them in the order they are drawn.
          const depth = (el) => { let d = 0; for (let e = el.parentElement; e && !roots.includes(e); e = e.parentElement) d += e.dataset?.nodeId ? 1 : 0; return d; };
          const stops = made.map((el) => ({ el, d: depth(el) })).sort((a, b) => a.d - b.d).slice(0, MAX_STOPS).map(({ el }) => el);
          stops.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
          if (stops.length) go(p, stops);
        }, 120);
        return;
      }
      const element = nodeIds.map(find).find(Boolean);
      if (element) go(p, [element]);
      else leave(p);
    },
  };
}

