// SemantiCode app shell — shared primitives used across all 4 variants.
// Editor-minimal, dark-first, mono-forward.

// ───── Design tokens ─────────────────────────────────────────────────
const T = {
  // neutrals (cool gray, hue 250)
  bg:         'oklch(0.178 0.008 260)',
  bgDeep:     'oklch(0.142 0.008 260)',
  panel:      'oklch(0.215 0.008 260)',
  panel2:     'oklch(0.245 0.008 260)',
  line:       'oklch(0.305 0.010 260)',
  lineSoft:   'oklch(0.255 0.010 260)',
  text:       'oklch(0.945 0.005 260)',
  textMid:    'oklch(0.745 0.010 260)',
  textDim:    'oklch(0.555 0.012 260)',
  textFaint:  'oklch(0.405 0.012 260)',
  // semantic kind colors — uniform chroma 0.16, lightness 0.72
  kind: {
    function:  'oklch(0.74 0.14 240)',  // blue
    component: 'oklch(0.74 0.14 300)',  // violet
    type:      'oklch(0.76 0.14 75)',   // amber
    hook:      'oklch(0.74 0.13 180)',  // teal
    class:     'oklch(0.72 0.15 15)',   // rose
    constant:  'oklch(0.74 0.13 145)',  // green
    hookAlt:   'oklch(0.74 0.13 180)',
    interface: 'oklch(0.76 0.13 50)',   // orange
  },
  fontMono: '"JetBrains Mono", "Geist Mono", "SF Mono", ui-monospace, Menlo, monospace',
  fontSans: '"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
};

// Accent is dynamic (tweakable). Default cyan.
const DEFAULT_ACCENT_HUE = 215;
const accentColor = (h, l=0.72, c=0.14) => `oklch(${l} ${c} ${h})`;

// ───── Sample data: a generic Todo app codebase ──────────────────────
const SAMPLE = {
  workspace: 'todo-app',
  branch: 'feat/offline-sync',
  path: '~/dev/todo-app',
  symbols: [
    // Pillar 1: Data
    { id: 'TodoStore',    name: 'TodoStore',    kind: 'class',     sig: 'class TodoStore',                    file: 'store/todoStore.ts',    col: 0, row: 0, callers: 14, loc: 142 },
    { id: 'useTodos',     name: 'useTodos',     kind: 'hook',      sig: '() → TodoStore',                     file: 'store/useTodos.ts',     col: 0, row: 1, callers: 9, loc: 38 },
    { id: 'Todo',         name: 'Todo',         kind: 'type',      sig: 'type Todo = { id, text, done }',     file: 'types.ts',              col: 0, row: 2, callers: 23, loc: 6 },
    { id: 'TodoFilter',   name: 'TodoFilter',   kind: 'type',      sig: "'all' | 'active' | 'done'",          file: 'types.ts',              col: 0, row: 3, callers: 6, loc: 1 },
    { id: 'persistTodos', name: 'persistTodos', kind: 'function',  sig: '(todos) → Promise<void>',            file: 'store/persist.ts',      col: 0, row: 4, callers: 3, loc: 21 },

    // Pillar 2: UI
    { id: 'TodoList',     name: 'TodoList',     kind: 'component', sig: '<TodoList items filter />',          file: 'components/TodoList.tsx',  col: 1, row: 0, callers: 1, heat: 0.9, loc: 46 },
    { id: 'TodoItem',     name: 'TodoItem',     kind: 'component', sig: '<TodoItem todo onToggle />',         file: 'components/TodoItem.tsx',  col: 1, row: 1, callers: 1, heat: 1.0, loc: 73 },
    { id: 'TodoInput',    name: 'TodoInput',    kind: 'component', sig: '<TodoInput onAdd />',                file: 'components/TodoInput.tsx', col: 1, row: 2, callers: 1, loc: 32 },
    { id: 'FilterBar',    name: 'FilterBar',    kind: 'component', sig: '<FilterBar value onChange />',       file: 'components/FilterBar.tsx', col: 1, row: 3, callers: 1, loc: 24 },
    { id: 'App',          name: 'App',          kind: 'component', sig: '<App />',                            file: 'App.tsx',                  col: 1, row: 4, callers: 1, loc: 58 },

    // Pillar 3: Sync
    { id: 'syncTodos',    name: 'syncTodos',    kind: 'function',  sig: '(local, remote) → Todo[]',           file: 'sync/syncTodos.ts',     col: 2, row: 0, callers: 2, heat: 0.8, loc: 64 },
    { id: 'useSync',      name: 'useSync',      kind: 'hook',      sig: '() → SyncState',                     file: 'sync/useSync.ts',       col: 2, row: 1, callers: 4, loc: 49 },
    { id: 'ApiClient',    name: 'ApiClient',    kind: 'class',     sig: 'class ApiClient',                    file: 'api/client.ts',         col: 2, row: 2, callers: 5, loc: 118 },
    { id: 'API_URL',      name: 'API_URL',      kind: 'constant',  sig: "'https://api.todo.app'",             file: 'config.ts',             col: 2, row: 3, callers: 2, loc: 1 },
    { id: 'conflictRes',  name: 'resolveConflict', kind: 'function', sig: '(a, b) → Todo',                    file: 'sync/conflict.ts',      col: 2, row: 4, callers: 1, heat: 0.5, loc: 37 },
  ],
  edges: [
    // UI → Data
    ['App', 'useTodos'], ['TodoList', 'useTodos'], ['TodoInput', 'useTodos'],
    ['TodoList', 'TodoItem'], ['App', 'TodoList'], ['App', 'FilterBar'], ['App', 'TodoInput'],
    ['TodoItem', 'Todo'], ['TodoList', 'TodoFilter'], ['FilterBar', 'TodoFilter'],
    // Data → Persist
    ['useTodos', 'TodoStore'], ['TodoStore', 'persistTodos'], ['TodoStore', 'Todo'],
    // Sync
    ['useSync', 'ApiClient'], ['useSync', 'syncTodos'], ['syncTodos', 'conflictRes'],
    ['syncTodos', 'Todo'], ['ApiClient', 'API_URL'], ['App', 'useSync'],
    ['TodoStore', 'syncTodos'],
  ],
};

// Rank color/label
const kindMeta = {
  function:  { tag: 'fn',    label: 'function'  },
  component: { tag: 'comp',  label: 'component' },
  type:      { tag: 'type',  label: 'type'      },
  hook:      { tag: 'hook',  label: 'hook'      },
  class:     { tag: 'class', label: 'class'     },
  constant:  { tag: 'const', label: 'constant'  },
  interface: { tag: 'intf',  label: 'interface' },
};

// ───── Layout helpers ───────────────────────────────────────────────

// Convert symbols (with col/row) to pixel positions on a canvas.
function layoutSymbols(symbols, { colW=280, rowH=96, padX=40, padY=40, nodeW=240, nodeH=72 } = {}) {
  const pos = {};
  for (const s of symbols) {
    pos[s.id] = {
      x: padX + s.col * colW,
      y: padY + s.row * rowH,
      w: nodeW,
      h: nodeH,
      kind: s.kind,
      symbol: s,
    };
  }
  return pos;
}

// Cubic bezier between two node centers (right edge → left edge).
function bezierEdge(a, b) {
  const x1 = a.x + a.w;
  const y1 = a.y + a.h / 2;
  const x2 = b.x;
  const y2 = b.y + b.h / 2;
  const dx = Math.max(40, Math.abs(x2 - x1) * 0.45);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}
// When edge is same column (vertical), route around
function routeEdge(a, b) {
  if (Math.abs(a.x - b.x) < 20) {
    const x1 = a.x + a.w / 2;
    const y1 = a.y + a.h;
    const x2 = b.x + b.w / 2;
    const y2 = b.y;
    const midY = (y1 + y2) / 2;
    return `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
  }
  return bezierEdge(a, b);
}

// ───── Atomic UI primitives ─────────────────────────────────────────

function KindDot({ kind, size = 8 }) {
  return (
    <span style={{
      display: 'inline-block',
      width: size, height: size, borderRadius: 2,
      background: T.kind[kind] || T.textMid,
      flex: '0 0 auto',
    }}/>
  );
}

function KindTag({ kind }) {
  const k = kindMeta[kind] || { tag: kind };
  return (
    <span style={{
      fontFamily: T.fontMono,
      fontSize: 9.5,
      letterSpacing: 0.6,
      textTransform: 'uppercase',
      color: T.kind[kind] || T.textMid,
      padding: '1px 5px',
      borderRadius: 3,
      background: `color-mix(in oklch, ${T.kind[kind] || T.textMid} 12%, transparent)`,
      lineHeight: 1.3,
    }}>{k.tag}</span>
  );
}

// Symbol node card (compact: title + kind + signature)
function SymbolNode({ symbol, x, y, w, h, density='compact', selected=false, highlighted=false, dimmed=false, accent }) {
  const color = T.kind[symbol.kind] || T.textMid;
  return (
    <div style={{
      position: 'absolute', left: x, top: y, width: w, minHeight: h,
      background: selected ? T.panel2 : T.panel,
      border: `1px solid ${selected ? accent : highlighted ? color : T.line}`,
      borderRadius: 4,
      boxShadow: selected ? `0 0 0 1px ${accent}, 0 8px 24px -8px ${accent}40` :
                 highlighted ? `0 0 0 1px ${color}60` :
                 '0 1px 0 rgba(0,0,0,0.2)',
      opacity: dimmed ? 0.35 : 1,
      padding: density === 'minimal' ? '6px 10px' : '8px 10px 9px',
      display: 'flex', flexDirection: 'column', gap: density === 'rich' ? 4 : 2,
      fontFamily: T.fontMono,
      transition: 'opacity .15s',
      overflow: 'hidden',
    }}>
      {/* left kind stripe */}
      <div style={{
        position: 'absolute', left: 0, top: 0, bottom: 0, width: 2,
        background: color,
      }}/>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <KindTag kind={symbol.kind} />
        <span style={{
          fontSize: 12.5, fontWeight: 500, color: T.text,
          letterSpacing: -0.1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          flex: 1, minWidth: 0,
        }}>{symbol.name}</span>
        {symbol.callers && density !== 'minimal' ? (
          <span style={{ fontSize: 10, color: T.textFaint }}>
            {symbol.callers}↵
          </span>
        ) : null}
      </div>

      {density !== 'minimal' && (
        <div style={{
          fontSize: 11, color: T.textDim, lineHeight: 1.3,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{symbol.sig}</div>
      )}
      {density === 'rich' && (
        <div style={{
          fontSize: 10, color: T.textFaint, lineHeight: 1.3, marginTop: 1,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{symbol.file}</div>
      )}

      {/* heat glow */}
      {symbol.heat ? (
        <div style={{
          position: 'absolute', inset: -1, borderRadius: 4, pointerEvents: 'none',
          boxShadow: `inset 0 0 0 1px ${color}${Math.round(symbol.heat * 80).toString(16).padStart(2,'0')}`,
        }}/>
      ) : null}
    </div>
  );
}

// The canvas with dot grid, nodes, and edges (SVG layer beneath).
function CodeCanvas({
  symbols = SAMPLE.symbols, edges = SAMPLE.edges, selectedId = null, highlightedIds = [],
  density='compact', accent, width, height,
  showMinimap = true, zoomLevel = 100,
  nodeW=240, nodeH=72, colW=280, rowH=96, padX=48, padY=48,
}) {
  const pos = layoutSymbols(symbols, { nodeW, nodeH, colW, rowH, padX, padY });
  const selectedNeighbors = new Set();
  if (selectedId) {
    selectedNeighbors.add(selectedId);
    for (const [a,b] of edges) {
      if (a === selectedId) selectedNeighbors.add(b);
      if (b === selectedId) selectedNeighbors.add(a);
    }
  }

  const dotGrid = `radial-gradient(circle at 1px 1px, ${T.lineSoft} 1px, transparent 0)`;

  return (
    <div style={{
      position: 'relative', width: '100%', height: '100%',
      background: T.bgDeep,
      backgroundImage: dotGrid,
      backgroundSize: '16px 16px',
      overflow: 'hidden',
    }}>
      {/* subtle vignette */}
      <div style={{
        position: 'absolute', inset: 0, pointerEvents: 'none',
        background: 'radial-gradient(ellipse at center, transparent 60%, rgba(0,0,0,0.35) 100%)',
      }}/>

      {/* SVG edge layer */}
      <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
        <defs>
          <marker id="arrowhead" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" fill={T.textFaint}/>
          </marker>
        </defs>
        {edges.map(([aId, bId], i) => {
          const a = pos[aId], b = pos[bId];
          if (!a || !b) return null;
          const isHighlit = selectedId && (aId === selectedId || bId === selectedId);
          const color = isHighlit ? (T.kind[a.kind] || accent) : T.lineSoft;
          const dimmed = selectedId && !isHighlit;
          return (
            <path
              key={i}
              d={routeEdge(a, b)}
              stroke={color}
              strokeWidth={isHighlit ? 1.5 : 1}
              fill="none"
              opacity={dimmed ? 0.25 : isHighlit ? 0.95 : 0.55}
              markerEnd={isHighlit ? 'url(#arrowhead)' : undefined}
            />
          );
        })}
      </svg>

      {/* Nodes */}
      {symbols.map(s => {
        const p = pos[s.id];
        const selected = s.id === selectedId;
        const highlit = highlightedIds.includes(s.id) || (selectedId && selectedNeighbors.has(s.id) && !selected);
        const dimmed = selectedId && !selectedNeighbors.has(s.id);
        return (
          <SymbolNode key={s.id} symbol={s}
            x={p.x} y={p.y} w={p.w} h={p.h}
            density={density} selected={selected}
            highlighted={!!highlit} dimmed={!!dimmed}
            accent={accent}/>
        );
      })}

      {/* Pillar labels */}
      {['Data', 'UI', 'Sync'].map((label, i) => (
        <div key={label} style={{
          position: 'absolute', left: padX + i * colW, top: 16,
          fontFamily: T.fontMono, fontSize: 10, letterSpacing: 1.2,
          textTransform: 'uppercase', color: T.textFaint,
        }}>{String(i+1).padStart(2,'0')} · {label}</div>
      ))}

      {/* Canvas chrome (bottom-left: zoom) */}
      <div style={{
        position: 'absolute', left: 16, bottom: 16, display: 'flex', gap: 4,
        fontFamily: T.fontMono, fontSize: 11,
      }}>
        {['−', zoomLevel + '%', '+', 'fit'].map((l, i) => (
          <button key={i} style={{
            background: T.panel, border: `1px solid ${T.line}`, color: T.textMid,
            padding: '4px 9px', borderRadius: 3, cursor: 'pointer',
            fontFamily: T.fontMono, fontSize: 11, minWidth: i===1 ? 44 : 0,
          }}>{l}</button>
        ))}
      </div>

      {/* Minimap */}
      {showMinimap && (
        <div style={{
          position: 'absolute', right: 16, bottom: 16,
          width: 148, height: 90, background: T.panel, border: `1px solid ${T.line}`,
          borderRadius: 4, padding: 6, overflow: 'hidden',
        }}>
          <div style={{ position: 'relative', width: '100%', height: '100%' }}>
            {symbols.map(s => (
              <div key={s.id} style={{
                position: 'absolute',
                left: `${(s.col/3) * 100}%`, top: `${(s.row/5) * 100}%`,
                width: 8, height: 4, borderRadius: 1,
                background: T.kind[s.kind] || T.textMid,
                opacity: 0.8,
              }}/>
            ))}
            <div style={{
              position: 'absolute', left: '10%', top: '15%', width: '58%', height: '70%',
              border: `1px solid ${accent}`, borderRadius: 2, pointerEvents: 'none',
            }}/>
          </div>
        </div>
      )}

      {/* Compass coords top-right */}
      <div style={{
        position: 'absolute', right: 16, top: 16, display: 'flex', gap: 10,
        fontFamily: T.fontMono, fontSize: 10, color: T.textFaint, letterSpacing: 0.6,
      }}>
        <span>15 SYMBOLS</span><span>·</span><span>22 EDGES</span><span>·</span><span>SEMANTIC</span>
      </div>
    </div>
  );
}

// ───── Toolbar ─────────────────────────────────────────────────────

function Toolbar({ accent, workspace = SAMPLE.workspace, branch = SAMPLE.branch, path = SAMPLE.path, layout = 'Semantic · clusters', variant = 'A' }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 16,
      padding: '0 14px', height: 44,
      background: T.panel,
      borderBottom: `1px solid ${T.line}`,
      fontFamily: T.fontMono, fontSize: 12, color: T.textMid,
      flex: '0 0 auto',
    }}>
      {/* Brand mark */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{
          width: 18, height: 18, borderRadius: 3,
          background: `conic-gradient(from 45deg, ${accent}, ${T.kind.component}, ${T.kind.type}, ${T.kind.hook}, ${accent})`,
          position: 'relative',
        }}>
          <div style={{ position: 'absolute', inset: 4, background: T.panel, borderRadius: 1.5 }}/>
        </div>
        <span style={{ color: T.text, fontWeight: 500, letterSpacing: -0.1 }}>semanticode</span>
      </div>

      <div style={{ width: 1, height: 20, background: T.line }}/>

      {/* Workspace breadcrumb */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <span style={{ color: T.textDim }}>{path.replace('~/dev/', '')}</span>
        <span style={{ color: T.textFaint }}>/</span>
        <span style={{ color: T.text }}>{workspace}</span>
        <span style={{
          marginLeft: 6, padding: '1px 6px', borderRadius: 999,
          background: `color-mix(in oklch, ${accent} 14%, transparent)`,
          color: accent, fontSize: 10.5, letterSpacing: 0.3,
        }}>⑂ {branch}</span>
      </div>

      <div style={{ flex: 1 }}/>

      {/* Layout selector — dropdown */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 9.5, letterSpacing: 1.2, color: T.textFaint, textTransform: 'uppercase' }}>view</span>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          background: T.panel2, border: `1px solid ${T.line}`,
          borderRadius: 3, padding: '4px 8px 4px 10px',
          fontFamily: T.fontMono, fontSize: 11.5, color: T.text,
          cursor: 'pointer', minWidth: 136,
        }}>
          <span style={{ width: 5, height: 5, borderRadius: 999, background: accent }}/>
          <span>semantic</span>
          <div style={{ flex: 1 }}/>
          <span style={{ color: T.textFaint, fontSize: 9 }}>▾</span>
        </div>
      </div>

      <div style={{ width: 1, height: 20, background: T.line }}/>

      {/* Preprocessing ready indicator */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: T.textDim }}>
        <span style={{
          width: 6, height: 6, borderRadius: 999,
          background: T.kind.constant,
          boxShadow: `0 0 8px ${T.kind.constant}`,
        }}/>
        <span>embeddings · 147/147</span>
      </div>

      {/* command bar hint */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '3px 8px 3px 10px', borderRadius: 3,
        border: `1px solid ${T.line}`, background: T.bgDeep, color: T.textDim,
      }}>
        <span>⌘K</span>
      </div>
    </div>
  );
}

// Fake but realistic code snippets keyed by symbol id — full file with
// a [start, end] range marking the symbol's lines.
const CODE_SNIPPETS = {
  TodoItem: {
    lang: 'tsx',
    lines: [
      "import { memo, useCallback } from 'react'",
      "import type { Todo } from '../types'",
      "import { useTodos } from '../store/useTodos'",
      "",
      "interface TodoItemProps {",
      "  todo: Todo",
      "  onToggle?: (id: string) => void",
      "}",
      "",
      "export const TodoItem = memo(function TodoItem({",
      "  todo,",
      "  onToggle,",
      "}: TodoItemProps) {",
      "  const { toggle, remove } = useTodos()",
      "",
      "  const handleToggle = useCallback(() => {",
      "    toggle(todo.id)",
      "    onToggle?.(todo.id)",
      "  }, [todo.id, toggle, onToggle])",
      "",
      "  return (",
      "    <li className={`todo ${todo.done ? 'is-done' : ''}`}>",
      "      <input",
      "        type=\"checkbox\"",
      "        checked={todo.done}",
      "        onChange={handleToggle}",
      "      />",
      "      <span className=\"todo-text\">{todo.text}</span>",
      "      <button onClick={() => remove(todo.id)}>×</button>",
      "    </li>",
      "  )",
      "})",
    ],
    range: [9, 31],
    highlight: [13, 18],
  },
  useTodos: {
    lang: 'ts',
    lines: [
      "import { useSyncExternalStore } from 'react'",
      "import { todoStore } from './todoStore'",
      "import type { Todo, TodoFilter } from '../types'",
      "",
      "export function useTodos(filter: TodoFilter = 'all') {",
      "  const todos = useSyncExternalStore(",
      "    todoStore.subscribe,",
      "    todoStore.getSnapshot,",
      "  )",
      "",
      "  const visible = todos.filter((t) => {",
      "    if (filter === 'active') return !t.done",
      "    if (filter === 'done') return t.done",
      "    return true",
      "  })",
      "",
      "  return {",
      "    todos: visible,",
      "    add:    todoStore.add,",
      "    toggle: todoStore.toggle,",
      "    remove: todoStore.remove,",
      "  }",
      "}",
    ],
    range: [4, 22],
    highlight: [5, 8],
  },
  syncTodos: {
    lang: 'ts',
    lines: [
      "import type { Todo } from '../types'",
      "import { resolveConflict } from './conflict'",
      "",
      "export function syncTodos(",
      "  local: Todo[],",
      "  remote: Todo[],",
      "): Todo[] {",
      "  const byId = new Map<string, Todo>()",
      "  for (const t of remote) byId.set(t.id, t)",
      "",
      "  for (const t of local) {",
      "    const other = byId.get(t.id)",
      "    if (!other) { byId.set(t.id, t); continue }",
      "    byId.set(t.id, resolveConflict(t, other))",
      "  }",
      "",
      "  return [...byId.values()].sort(",
      "    (a, b) => a.createdAt - b.createdAt,",
      "  )",
      "}",
    ],
    range: [3, 19],
    highlight: [10, 14],
  },
};
CODE_SNIPPETS.TodoList = CODE_SNIPPETS.TodoItem;
CODE_SNIPPETS.TodoInput = CODE_SNIPPETS.TodoItem;
CODE_SNIPPETS.App = CODE_SNIPPETS.TodoItem;
CODE_SNIPPETS.FilterBar = CODE_SNIPPETS.TodoItem;
CODE_SNIPPETS.useSync = CODE_SNIPPETS.useTodos;
CODE_SNIPPETS.TodoStore = CODE_SNIPPETS.useTodos;
CODE_SNIPPETS.ApiClient = CODE_SNIPPETS.useTodos;
CODE_SNIPPETS.persistTodos = CODE_SNIPPETS.syncTodos;
CODE_SNIPPETS.conflictRes = CODE_SNIPPETS.syncTodos;
CODE_SNIPPETS.Todo = CODE_SNIPPETS.useTodos;
CODE_SNIPPETS.TodoFilter = CODE_SNIPPETS.useTodos;
CODE_SNIPPETS.API_URL = CODE_SNIPPETS.useTodos;

// Minimal JS/TS syntax highlighter — returns a list of { text, color } spans.
function highlightLine(line) {
  const tokens = [];
  const patterns = [
    { re: /\/\/.*$/,                                   color: T.textFaint },
    { re: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/, color: T.kind.constant },
    { re: /\b(import|from|export|const|let|var|function|return|if|else|for|of|in|interface|type|class|extends|new|async|await|default)\b/, color: T.kind.component },
    { re: /\b(useSyncExternalStore|useCallback|memo|Map|Promise|String|Number)\b/, color: T.kind.hook },
    { re: /\b(true|false|null|undefined)\b/,           color: T.kind.type },
    { re: /\b\d+(?:\.\d+)?\b/,                         color: T.kind.type },
    { re: /[{}()[\],;]/,                               color: T.textDim },
    { re: /[=+\-*/<>!?&|:]/,                           color: T.kind.hook },
  ];
  let rest = line;
  while (rest.length) {
    let best = null;
    for (const p of patterns) {
      const m = rest.match(p.re);
      if (m && m.index !== undefined) {
        if (!best || m.index < best.index) best = { m, p };
      }
    }
    if (!best) { tokens.push({ text: rest, color: T.text }); break; }
    if (best.m.index > 0) tokens.push({ text: rest.slice(0, best.m.index), color: T.text });
    tokens.push({ text: best.m[0], color: best.p.color });
    rest = rest.slice(best.m.index + best.m[0].length);
  }
  return tokens;
}

// ───── Inspector (right panel) ─────────────────────────────────────

function Inspector({ symbol, accent, compact=false }) {
  if (!symbol) {
    return (
      <div style={{
        padding: 14, color: T.textFaint, fontFamily: T.fontMono, fontSize: 11,
      }}>Select a symbol to inspect.</div>
    );
  }
  const color = T.kind[symbol.kind] || T.textMid;
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
      fontFamily: T.fontMono, fontSize: 12,
    }}>
      {/* Header */}
      <div style={{ padding: '14px 14px 12px', borderBottom: `1px solid ${T.line}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
          <KindTag kind={symbol.kind}/>
          <span style={{ fontSize: 10, color: T.textFaint, letterSpacing: 0.4 }}>
            {symbol.file}
          </span>
        </div>
        <div style={{
          fontSize: 18, color: T.text, letterSpacing: -0.3, fontWeight: 500,
          fontFamily: T.fontMono,
        }}>{symbol.name}</div>
        <div style={{ fontSize: 12, color: T.textDim, marginTop: 4 }}>{symbol.sig}</div>
      </div>

      {/* Code (symbol range highlighted within file) */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', borderBottom: `1px solid ${T.line}` }}>
        <div style={{
          padding: '10px 14px 8px', display: 'flex', alignItems: 'center', gap: 8,
          borderBottom: `1px solid ${T.lineSoft}`,
        }}>
          <span style={{
            fontSize: 9.5, letterSpacing: 1.2, textTransform: 'uppercase',
            color: T.textFaint,
          }}>Code</span>
          <span style={{ color: T.textFaint, fontSize: 10 }}>·</span>
          <span style={{ color: T.textDim, fontSize: 10.5 }}>
            L{(CODE_SNIPPETS[symbol.id]?.range[0] ?? 0)+1}–L{(CODE_SNIPPETS[symbol.id]?.range[1] ?? 0)+1}
          </span>
          <div style={{ flex: 1 }}/>
          <span style={{ color: T.textFaint, fontSize: 10 }}>{symbol.loc ?? '—'} LOC</span>
        </div>
        <div style={{
          flex: 1, minHeight: 0, overflow: 'auto',
          background: T.bgDeep, padding: '6px 0',
          fontFamily: T.fontMono, fontSize: 10.5, lineHeight: 1.55,
        }}>
          {(() => {
            const snip = CODE_SNIPPETS[symbol.id] || CODE_SNIPPETS.useTodos;
            const [rStart, rEnd] = snip.range;
            const [hStart, hEnd] = snip.highlight;
            return snip.lines.map((line, i) => {
              const inRange = i >= rStart && i <= rEnd;
              const isHot = i >= hStart && i <= hEnd;
              const gutterW = 30;
              return (
                <div key={i} style={{
                  display: 'flex', position: 'relative',
                  background: isHot ? `color-mix(in oklch, ${color} 10%, transparent)` :
                              inRange ? `color-mix(in oklch, ${color} 4%, transparent)` :
                              'transparent',
                  opacity: inRange ? 1 : 0.35,
                }}>
                  {/* range bar */}
                  {inRange && (
                    <div style={{
                      position: 'absolute', left: 0, top: 0, bottom: 0,
                      width: 2, background: isHot ? color : `color-mix(in oklch, ${color} 45%, transparent)`,
                    }}/>
                  )}
                  <span style={{
                    display: 'inline-block', width: gutterW, textAlign: 'right',
                    paddingRight: 8, color: T.textFaint, fontSize: 10,
                    userSelect: 'none', flex: '0 0 auto',
                  }}>{i+1}</span>
                  <span style={{
                    paddingLeft: 8, paddingRight: 14, whiteSpace: 'pre',
                    overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    {line === '' ? '\u00A0' : highlightLine(line).map((tok, j) => (
                      <span key={j} style={{ color: tok.color }}>{tok.text}</span>
                    ))}
                  </span>
                </div>
              );
            });
          })()}
        </div>
      </div>

      {/* Call graph — condensed */}
      <div style={{ padding: '10px 14px', borderBottom: `1px solid ${T.line}` }}>
        <div style={{
          fontSize: 9.5, letterSpacing: 1.2, textTransform: 'uppercase',
          color: T.textFaint, marginBottom: 6,
        }}>Callers · {symbol.callers ?? 0}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {['App', 'TodoList', 'TodoInput'].slice(0, compact ? 2 : 3).map(n => (
            <span key={n} style={{
              fontSize: 10.5, padding: '2px 6px',
              background: T.panel2, border: `1px solid ${T.line}`, borderRadius: 3,
              color: T.textMid,
            }}>{n}</span>
          ))}
        </div>
      </div>

      {/* Actions */}
      <div style={{ padding: 12, borderTop: `1px solid ${T.line}`, display: 'flex', gap: 6 }}>
        <button style={{
          flex: 1, background: accent, color: T.bgDeep, border: 'none',
          padding: '6px 10px', borderRadius: 3, fontFamily: T.fontMono, fontSize: 11,
          fontWeight: 600, cursor: 'pointer', letterSpacing: 0.2,
        }}>ask agent ↵</button>
        <button style={{
          background: T.panel2, color: T.textMid, border: `1px solid ${T.line}`,
          padding: '6px 10px', borderRadius: 3, fontFamily: T.fontMono, fontSize: 11,
          cursor: 'pointer',
        }}>open →</button>
      </div>
    </div>
  );
}

// ───── Agent surfaces (4 styles) ───────────────────────────────────

// Chat messages shared
const AGENT_MSGS = [
  { role: 'user', text: 'The TodoItem re-renders on every keystroke in TodoInput. Find the root cause and fix it.' },
  { role: 'agent', text: 'Tracing data flow:', trace: [
    { sym: 'TodoInput',  kind: 'component', note: 'emits onAdd; local state' },
    { sym: 'App',        kind: 'component', note: 'subscribes via useTodos' },
    { sym: 'useTodos',   kind: 'hook',      note: 'returns full todos array' },
    { sym: 'TodoItem',   kind: 'component', note: 'receives `todo` by ref' },
  ]},
  { role: 'agent', text: 'Root cause: useTodos returns a new array reference on every store read, so TodoList maps again and each TodoItem is recreated. Proposed fix: memoize the returned slice in useTodos with a shallow-equal selector.' },
  { role: 'user', text: 'Apply it. Preserve filter semantics.' },
  { role: 'agent', text: 'Editing 1 file · useTodos.ts (+7 −2). Tests pass (14/14). Ready to commit.' },
];

function AgentChatPanel({ accent }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
      fontFamily: T.fontMono, fontSize: 11.5,
    }}>
      {/* Header */}
      <div style={{
        padding: '10px 12px', borderBottom: `1px solid ${T.line}`,
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <div style={{
          width: 6, height: 6, borderRadius: 999, background: accent,
          boxShadow: `0 0 6px ${accent}`,
        }}/>
        <span style={{ color: T.text, fontWeight: 500 }}>agent</span>
        <span style={{ color: T.textFaint, fontSize: 10 }}>claude · sonnet</span>
        <div style={{ flex: 1 }}/>
        <span style={{
          padding: '1px 6px', fontSize: 9.5, letterSpacing: 0.6,
          background: T.panel2, border: `1px solid ${T.line}`, borderRadius: 3,
          color: T.textMid,
        }}>following · TodoItem</span>
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflow: 'hidden', padding: '12px 12px 0', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {AGENT_MSGS.map((m, i) => (
          <div key={i}>
            <div style={{
              fontSize: 9.5, letterSpacing: 1.2, textTransform: 'uppercase',
              color: m.role === 'user' ? accent : T.textFaint, marginBottom: 5,
            }}>{m.role === 'user' ? 'you' : 'agent'}</div>
            <div style={{
              color: m.role === 'user' ? T.text : T.textMid,
              lineHeight: 1.55, fontFamily: m.role === 'user' ? T.fontMono : T.fontSans,
              fontSize: m.role === 'user' ? 12 : 12.5,
            }}>{m.text}</div>
            {m.trace && (
              <div style={{
                marginTop: 6, padding: '6px 8px',
                border: `1px dashed ${T.line}`, borderRadius: 3,
                background: T.bgDeep,
                display: 'flex', flexDirection: 'column', gap: 3,
              }}>
                {m.trace.map((t, j) => (
                  <div key={j} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11 }}>
                    <span style={{ color: T.textFaint, width: 10 }}>{j === m.trace.length-1 ? '└' : '├'}</span>
                    <KindDot kind={t.kind} size={6}/>
                    <span style={{ color: T.text }}>{t.sym}</span>
                    <span style={{ color: T.textDim, fontSize: 10.5 }}>— {t.note}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Composer */}
      <div style={{ padding: 10, borderTop: `1px solid ${T.line}` }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 10px', background: T.bgDeep,
          border: `1px solid ${T.line}`, borderRadius: 4,
        }}>
          <span style={{ color: accent, fontSize: 12 }}>▸</span>
          <span style={{ color: T.textFaint, flex: 1, fontFamily: T.fontMono }}>message agent… @ to reference a symbol</span>
          <span style={{ fontSize: 10, color: T.textFaint }}>⏎</span>
        </div>
      </div>
    </div>
  );
}

// Bottom drawer variant
function AgentDrawer({ accent }) {
  return (
    <div style={{
      height: 220, background: T.panel, borderTop: `1px solid ${T.line}`,
      display: 'flex', fontFamily: T.fontMono, fontSize: 11,
    }}>
      {/* left: tabs */}
      <div style={{
        width: 140, borderRight: `1px solid ${T.line}`,
        padding: '10px 0', display: 'flex', flexDirection: 'column', gap: 1,
      }}>
        {[{n:'agent', active:true, dot:accent}, {n:'runs', dot:T.kind.constant}, {n:'terminal'}, {n:'problems'}, {n:'diff'}].map(t => (
          <div key={t.n} style={{
            padding: '5px 12px', color: t.active ? T.text : T.textDim,
            background: t.active ? T.panel2 : 'transparent',
            borderLeft: `2px solid ${t.active ? accent : 'transparent'}`,
            display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer',
          }}>
            {t.dot ? <span style={{ width: 5, height: 5, borderRadius: 999, background: t.dot }}/> : <span style={{ width: 5 }}/>}
            <span>{t.n}</span>
          </div>
        ))}
      </div>
      {/* right: agent log */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div style={{
          padding: '8px 12px', borderBottom: `1px solid ${T.line}`,
          display: 'flex', alignItems: 'center', gap: 10, color: T.textMid,
        }}>
          <span style={{ color: T.text }}>▸ session-042</span>
          <span style={{ color: T.textFaint }}>·</span>
          <span style={{ color: T.textFaint }}>editing useTodos.ts</span>
          <div style={{ flex: 1 }}/>
          <span style={{ color: T.textFaint }}>14/14 tests</span>
          <span style={{
            padding: '1px 6px', borderRadius: 3,
            background: `color-mix(in oklch, ${T.kind.constant} 18%, transparent)`,
            color: T.kind.constant,
          }}>ready</span>
        </div>
        <div style={{ flex: 1, padding: '8px 12px', overflow: 'hidden' }}>
          {[
            '› trace useTodos.ts#useTodos → TodoStore.getAll',
            '› selector returns new array reference · every call',
            '› propose: shallow-equal memoize, preserve filter semantics',
            '› apply patch · 1 file, +7 −2',
            '› run: npm test -- --watch=false',
            '› pass: 14/14 in 1.2s',
          ].map((l, i) => (
            <div key={i} style={{ color: T.textMid, lineHeight: 1.6 }}>
              <span style={{ color: T.textFaint, marginRight: 8 }}>{(i+1).toString().padStart(2,'0')}</span>
              {l}
            </div>
          ))}
        </div>
        <div style={{
          padding: '8px 12px', borderTop: `1px solid ${T.line}`,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span style={{ color: accent }}>▸</span>
          <span style={{ color: T.textFaint }}>apply · commit · undo · continue</span>
        </div>
      </div>
    </div>
  );
}

// Floating command palette variant
function AgentPalette({ accent, top=90, left='50%' }) {
  return (
    <div style={{
      position: 'absolute', top, left, transform: 'translateX(-50%)',
      width: 540, background: T.panel,
      border: `1px solid ${T.line}`, borderRadius: 6,
      boxShadow: '0 24px 64px -16px rgba(0,0,0,.6), 0 0 0 1px rgba(0,0,0,.3)',
      fontFamily: T.fontMono, fontSize: 12,
      overflow: 'hidden', zIndex: 50,
    }}>
      <div style={{
        padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10,
        borderBottom: `1px solid ${T.line}`,
      }}>
        <span style={{ color: accent, fontSize: 13 }}>▸</span>
        <span style={{ color: T.text, flex: 1 }}>why does TodoItem re-render on every keystroke in TodoInput?</span>
        <span style={{ color: T.textFaint, fontSize: 10 }}>⏎ ask</span>
      </div>
      <div style={{ padding: '6px 0' }}>
        <div style={{ padding: '4px 14px', fontSize: 9.5, letterSpacing: 1.2, color: T.textFaint, textTransform: 'uppercase' }}>
          symbols in scope · 4
        </div>
        {[
          {n:'TodoInput',  k:'component', f:'components/TodoInput.tsx'},
          {n:'TodoItem',   k:'component', f:'components/TodoItem.tsx'},
          {n:'useTodos',   k:'hook',      f:'store/useTodos.ts'},
          {n:'TodoStore',  k:'class',     f:'store/todoStore.ts'},
        ].map((s, i) => (
          <div key={s.n} style={{
            padding: '6px 14px', display: 'flex', alignItems: 'center', gap: 10,
            background: i === 0 ? T.panel2 : 'transparent',
            borderLeft: `2px solid ${i === 0 ? accent : 'transparent'}`,
          }}>
            <KindTag kind={s.k}/>
            <span style={{ color: T.text }}>{s.n}</span>
            <span style={{ color: T.textFaint, fontSize: 10.5 }}>{s.f}</span>
            <div style={{ flex: 1 }}/>
            <span style={{ color: T.textFaint, fontSize: 10 }}>@{s.n}</span>
          </div>
        ))}
      </div>
      <div style={{
        padding: '8px 14px', borderTop: `1px solid ${T.line}`, background: T.bgDeep,
        display: 'flex', gap: 14, color: T.textFaint, fontSize: 10.5,
      }}>
        <span>↑↓ select</span><span>⏎ ask</span><span>tab insert @ref</span><span>⎋ close</span>
      </div>
    </div>
  );
}

// Inline-on-hover popover variant (anchors to a node on the canvas)
function AgentInlinePopover({ accent, top, left, targetSymbol }) {
  return (
    <div style={{
      position: 'absolute', top, left, width: 320,
      background: T.panel, border: `1px solid ${T.line}`, borderRadius: 5,
      boxShadow: '0 16px 40px -12px rgba(0,0,0,.55)',
      fontFamily: T.fontMono, fontSize: 11, zIndex: 20,
      overflow: 'hidden',
    }}>
      {/* tail */}
      <div style={{
        position: 'absolute', top: -6, left: 24, width: 10, height: 10,
        background: T.panel, borderLeft: `1px solid ${T.line}`,
        borderTop: `1px solid ${T.line}`, transform: 'rotate(45deg)',
      }}/>
      <div style={{ padding: '10px 12px 8px', borderBottom: `1px solid ${T.line}`, display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ width: 6, height: 6, borderRadius: 999, background: accent, boxShadow: `0 0 6px ${accent}` }}/>
        <span style={{ color: T.text }}>ask about</span>
        <KindTag kind={targetSymbol.kind}/>
        <span style={{ color: T.text, fontWeight: 500 }}>{targetSymbol.name}</span>
      </div>
      <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {[
          'explain this component',
          'find re-render triggers',
          'propose a refactor',
          'add test coverage',
        ].map((a, i) => (
          <div key={i} style={{
            padding: '6px 8px', borderRadius: 3,
            background: i === 1 ? T.panel2 : 'transparent',
            borderLeft: `2px solid ${i === 1 ? accent : 'transparent'}`,
            color: i === 1 ? T.text : T.textMid,
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <span style={{ color: T.textFaint, fontSize: 10 }}>{String(i+1)}.</span>
            <span>{a}</span>
            {i === 1 && <span style={{ marginLeft: 'auto', color: T.textFaint, fontSize: 9.5 }}>⏎</span>}
          </div>
        ))}
      </div>
      <div style={{
        padding: '8px 12px', borderTop: `1px solid ${T.line}`,
        background: T.bgDeep, display: 'flex', gap: 8, alignItems: 'center',
      }}>
        <span style={{ color: accent }}>▸</span>
        <span style={{ color: T.textFaint }}>or type a question…</span>
      </div>
    </div>
  );
}

Object.assign(window, {
  T, accentColor, DEFAULT_ACCENT_HUE, SAMPLE, kindMeta,
  layoutSymbols, routeEdge, CODE_SNIPPETS, highlightLine,
  KindDot, KindTag, SymbolNode, CodeCanvas,
  Toolbar, Inspector,
  AgentChatPanel, AgentDrawer, AgentPalette, AgentInlinePopover,
});
