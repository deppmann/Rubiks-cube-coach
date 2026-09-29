// 2D cube net (cross layout) built from CSS-grid divs. Tap a non-center sticker to cycle
// its color; onChange fires with the new facelet string.
import { COLOR_OF, FACES } from './cube.js';

// Same palette as viewer3d's STICKER_HEX, kept local so this module stands alone.
export const NET_HEX = { white: '#ffffff', yellow: '#ffd500', green: '#009b48', blue: '#0046ad', red: '#b71234', orange: '#ff5800' };

const FACE_NAMES = { U: 'Up', R: 'Right', F: 'Front', D: 'Down', L: 'Left', B: 'Back' };
// Face origin (column, row) in the 12×9 grid: U on top, then L F R B, then D.
const ORIGIN = { U: [3, 0], L: [0, 3], F: [3, 3], R: [6, 3], B: [9, 3], D: [3, 6] };
const CYCLE = ['white', 'yellow', 'green', 'blue', 'red', 'orange'];

const CSS = `
.ne-net{display:grid;grid-template-columns:repeat(12,var(--ne-cell,26px));grid-template-rows:repeat(9,var(--ne-cell,26px));
  gap:2px;justify-content:center;--ne-cell:min(30px,calc((100vw - 32px - 22px) / 12))}
.ne-st{border:1px solid rgba(0,0,0,.45);border-radius:20%;padding:0;margin:0;cursor:pointer;touch-action:manipulation;
  -webkit-tap-highlight-color:transparent;position:relative}
.ne-st[disabled]{cursor:default;opacity:1}
.ne-st.ne-center{border-width:2px}
.ne-st.ne-flag{outline:3px solid #ff2d95;outline-offset:1px;z-index:1}
.ne-st::after{content:"";position:absolute;inset:-2px} /* enlarges the tap target into the gap */
`;

export class NetEditor {
  constructor(container, { colorOf = COLOR_OF, editable = true } = {}) {
    this.container = container;
    this.colorOf = colorOf;
    this.editable = editable;
    this.state = FACES.map((f) => f.repeat(9)).join('');
    this.flags = new Set();
    this.listeners = [];
    if (!document.getElementById('ne-style')) {
      const st = document.createElement('style');
      st.id = 'ne-style';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    this.grid = document.createElement('div');
    this.grid.className = 'ne-net';
    container.appendChild(this.grid);
    this.cells = [];
    FACES.forEach((face, fi) => {
      const [ox, oy] = ORIGIN[face];
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          const i = fi * 9 + r * 3 + c;
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'ne-st' + (r === 1 && c === 1 ? ' ne-center' : '');
          b.style.gridColumn = String(ox + c + 1);
          b.style.gridRow = String(oy + r + 1);
          if (r === 1 && c === 1) b.disabled = true;
          else if (!editable) b.disabled = true;
          else b.addEventListener('click', () => this._cycle(i));
          this.grid.appendChild(b);
          this.cells[i] = b;
        }
      }
    });
    this._render();
  }

  setState(facelets) { this.state = facelets; this._render(); }
  getState() { return this.state; }
  onChange(fn) { this.listeners.push(fn); }
  // Outline doubtful stickers (indices into the facelet string).
  setFlags(indices = []) { this.flags = new Set(indices); this._render(); }

  _cycle(i) {
    const cur = CYCLE.indexOf(this.colorOf[this.state[i]]);
    const next = CYCLE[(cur + 1) % CYCLE.length];
    const letter = FACES.find((f) => this.colorOf[f] === next);
    this.state = this.state.slice(0, i) + letter + this.state.slice(i + 1);
    this.flags.delete(i); // a manual fix settles the doubt
    this._render();
    this.listeners.forEach((fn) => fn(this.state));
  }

  _render() {
    this.cells.forEach((b, i) => {
      const color = this.colorOf[this.state[i]];
      const face = FACES[Math.floor(i / 9)], r = Math.floor((i % 9) / 3) + 1, c = (i % 3) + 1;
      b.style.background = NET_HEX[color] || '#888';
      b.setAttribute('aria-label', `${FACE_NAMES[face]} face, row ${r} column ${c}, ${color}`);
      b.classList.toggle('ne-flag', this.flags.has(i));
    });
  }
}
