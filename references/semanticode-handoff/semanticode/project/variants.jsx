// Four full-app-shell variants.

const BOARD_W = 1440;
const BOARD_H = 900;

// Extra phantom symbols so the grouped list feels dense (like a real codebase).
const EXTRA_SYMBOLS = [
  { id:'x1',  name:'App',            kind:'component', loc:58,  file:'App.tsx' },
  { id:'x2',  name:'TodoRoute',      kind:'component', loc:42,  file:'routes/TodoRoute.tsx' },
  { id:'x3',  name:'SettingsRoute',  kind:'component', loc:37,  file:'routes/SettingsRoute.tsx' },
  { id:'x4',  name:'Layout',         kind:'component', loc:28,  file:'components/Layout.tsx' },
  { id:'x5',  name:'EmptyState',     kind:'component', loc:19,  file:'components/EmptyState.tsx' },
  { id:'x6',  name:'Toast',          kind:'component', loc:33,  file:'components/Toast.tsx' },
  { id:'x7',  name:'usePersist',     kind:'hook',      loc:41,  file:'store/usePersist.ts' },
  { id:'x8',  name:'useDebounce',    kind:'hook',      loc:18,  file:'hooks/useDebounce.ts' },
  { id:'x9',  name:'useKeyboard',    kind:'hook',      loc:24,  file:'hooks/useKeyboard.ts' },
  { id:'x10', name:'useOnline',      kind:'hook',      loc:12,  file:'hooks/useOnline.ts' },
  { id:'x11', name:'validateTodo',   kind:'function',  loc:19,  file:'utils/validate.ts' },
  { id:'x12', name:'diffTodos',      kind:'function',  loc:44,  file:'sync/diff.ts' },
  { id:'x13', name:'serialize',      kind:'function',  loc:11,  file:'utils/serialize.ts' },
  { id:'x14', name:'TodoFilter',     kind:'type',      loc:1,   file:'types.ts' },
  { id:'x15', name:'SyncState',      kind:'type',      loc:5,   file:'sync/types.ts' },
  { id:'x16', name:'ApiError',       kind:'class',     loc:22,  file:'api/errors.ts' },
  { id:'x17', name:'STORAGE_KEY',    kind:'constant',  loc:1,   file:'config.ts' },
];

function buildGroupedSymbols(symbols) {
  const order = ['component', 'hook', 'class', 'function', 'type', 'constant'];
  const map = {};
  for (const s of symbols) {
    (map[s.kind] = map[s.kind] || []).push(s);
  }
  for (const k of Object.keys(map)) {
    map[k].sort((a, b) => (b.loc ?? 0) - (a.loc ?? 0));
  }
  return order.filter(k => map[k]).map(k => ({
    kind: k,
    items: map[k],
  }));
}

function ComplexityBar({ loc, max, color }) {
  const pct = Math.max(0.05, Math.min(1, (loc ?? 0) / max));
  return (
    <div style={{
      width: 26, height: 3, background: T.bgDeep, borderRadius: 1, overflow: 'hidden',
      flex: '0 0 auto',
    }}>
      <div style={{ width: `${pct*100}%`, height: '100%', background: color, opacity: 0.65 }}/>
    </div>
  );
}

function GroupedSymbolList({ symbols, selectedId, accent }) {
  const groups = buildGroupedSymbols(symbols);
  const [collapsed, setCollapsed] = React.useState({});
  const totalLoc = Math.max(...symbols.map(s => s.loc ?? 0), 1);
  return (
    <div style={{ padding: '6px 0', overflow: 'auto', flex: 1 }}>
      {groups.map(g => {
        const isCollapsed = collapsed[g.kind];
        const color = T.kind[g.kind] || T.textMid;
        const sumLoc = g.items.reduce((a, s) => a + (s.loc ?? 0), 0);
        return (
          <div key={g.kind} style={{ marginBottom: 4 }}>
            <div
              onClick={() => setCollapsed(c => ({ ...c, [g.kind]: !c[g.kind] }))}
              style={{
                display: 'flex', alignItems: 'center', gap: 7,
                padding: '5px 10px 5px 8px', cursor: 'pointer',
                fontSize: 9.5, letterSpacing: 1.3, textTransform: 'uppercase',
                color: T.textDim,
              }}>
              <span style={{ width: 8, color: T.textFaint, fontSize: 8 }}>{isCollapsed ? '▸' : '▾'}</span>
              <span style={{ width: 5, height: 5, borderRadius: 999, background: color }}/>
              <span style={{ color: T.textMid }}>{({class:'classes',component:'components',hook:'hooks',function:'functions',type:'types',constant:'constants',interface:'interfaces'})[g.kind] || g.kind}</span>
              <div style={{ flex: 1 }}/>
              <span style={{ color: T.textFaint, fontSize: 9.5, letterSpacing: 0.4 }}>
                {g.items.length} · {sumLoc} loc
              </span>
            </div>
            {!isCollapsed && g.items.map(s => (
              <div key={s.id} style={{
                display: 'flex', alignItems: 'center', gap: 7,
                padding: '3px 10px 3px 22px', borderRadius: 0,
                background: s.id === selectedId ? T.panel2 : 'transparent',
                borderLeft: `2px solid ${s.id === selectedId ? accent : 'transparent'}`,
                marginLeft: -2,
              }}>
                <span style={{
                  color: s.id === selectedId ? T.text : T.textMid,
                  flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  fontSize: 11.5,
                }}>{s.name}</span>
                <ComplexityBar loc={s.loc} max={totalLoc} color={color}/>
                <span style={{ color: T.textFaint, fontSize: 9.5, minWidth: 22, textAlign: 'right' }}>
                  {s.loc}
                </span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

// Variant A — Chat panel right (Linear-ish: sidebar + canvas + agent)
function VariantA({ accent, density }) {
  const selected = SAMPLE.symbols.find(s => s.id === 'TodoItem');
  const allSymbols = [...SAMPLE.symbols, ...EXTRA_SYMBOLS];
  return (
    <div style={{
      width: BOARD_W, height: BOARD_H,
      background: T.bg, color: T.text, display: 'flex', flexDirection: 'column',
      fontFamily: T.fontSans, overflow: 'hidden',
    }}>
      <Toolbar accent={accent} variant="A"/>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* Left: grouped symbol outline */}
        <div style={{
          width: 248, background: T.panel, borderRight: `1px solid ${T.line}`,
          display: 'flex', flexDirection: 'column', fontFamily: T.fontMono, fontSize: 11.5,
          minHeight: 0,
        }}>
          <div style={{ padding: '10px 12px 9px', borderBottom: `1px solid ${T.line}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 9.5, letterSpacing: 1.3, color: T.textFaint, textTransform: 'uppercase' }}>Symbols</span>
              <span style={{ color: T.textFaint, fontSize: 10 }}>· {allSymbols.length}</span>
              <div style={{ flex: 1 }}/>
              <span style={{ fontSize: 9.5, letterSpacing: 0.3, color: T.textFaint }}>sort: loc ▾</span>
            </div>
            <div style={{
              marginTop: 7, display: 'flex', alignItems: 'center', gap: 6,
              padding: '4px 8px', background: T.bgDeep,
              border: `1px solid ${T.line}`, borderRadius: 3,
            }}>
              <span style={{ color: T.textFaint, fontSize: 10 }}>⌕</span>
              <span style={{ color: T.textFaint, fontSize: 10.5 }}>filter symbols…</span>
            </div>
          </div>
          <GroupedSymbolList symbols={allSymbols} selectedId={selected.id} accent={accent}/>
          <div style={{
            padding: '6px 12px', borderTop: `1px solid ${T.line}`,
            fontSize: 9.5, letterSpacing: 0.4, color: T.textFaint,
            display: 'flex', gap: 10,
          }}>
            <span>≡ group · kind</span>
            <div style={{ flex: 1 }}/>
            <span>{allSymbols.reduce((a,s)=>a+(s.loc??0),0)} loc</span>
          </div>
        </div>

        {/* Center: canvas */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <div style={{ flex: 1, position: 'relative' }}>
            <CodeCanvas accent={accent} density={density} selectedId="TodoItem"/>
          </div>
        </div>

        {/* Right: inspector (full height — code shown here) */}
        <div style={{
          width: 360, background: T.panel, borderLeft: `1px solid ${T.line}`,
          display: 'flex', flexDirection: 'column', minHeight: 0,
        }}>
          <Inspector symbol={selected} accent={accent}/>
        </div>
      </div>

      {/* Agent now a thin always-visible composer strip at the bottom */}
      <div style={{
        height: 40, background: T.panel, borderTop: `1px solid ${T.line}`,
        display: 'flex', alignItems: 'center', gap: 10, padding: '0 14px',
        fontFamily: T.fontMono, fontSize: 11.5, color: T.textMid,
      }}>
        <span style={{ width: 6, height: 6, borderRadius: 999, background: accent, boxShadow: `0 0 6px ${accent}` }}/>
        <span style={{ color: T.text }}>agent</span>
        <span style={{ color: T.textFaint, fontSize: 10 }}>· following TodoItem</span>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8,
          padding: '6px 10px', background: T.bgDeep,
          border: `1px solid ${T.line}`, borderRadius: 3, marginLeft: 6 }}>
          <span style={{ color: accent }}>▸</span>
          <span style={{ color: T.textFaint }}>message agent… @ to reference a symbol</span>
        </div>
        <span style={{ color: T.textFaint, fontSize: 10 }}>⏎</span>
      </div>
    </div>
  );
}

// Variant B — Canvas-first, bottom drawer agent (Zed-ish)
function VariantB({ accent, density }) {
  const selected = SAMPLE.symbols.find(s => s.id === 'syncTodos');
  return (
    <div style={{
      width: BOARD_W, height: BOARD_H, background: T.bg, color: T.text,
      display: 'flex', flexDirection: 'column', fontFamily: T.fontSans, overflow: 'hidden',
    }}>
      <Toolbar accent={accent} variant="B"/>
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* Canvas full width */}
        <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
          <CodeCanvas accent={accent} density={density} selectedId="syncTodos"/>
        </div>

        {/* Inspector on the right, slim */}
        <div style={{
          width: 300, background: T.panel, borderLeft: `1px solid ${T.line}`,
          display: 'flex', flexDirection: 'column',
        }}>
          <Inspector symbol={selected} accent={accent}/>
        </div>
      </div>

      {/* Bottom drawer */}
      <AgentDrawer accent={accent}/>
    </div>
  );
}

// Variant C — Command palette agent (keyboard-first, minimal chrome)
function VariantC({ accent, density }) {
  const selected = SAMPLE.symbols.find(s => s.id === 'useTodos');
  return (
    <div style={{
      width: BOARD_W, height: BOARD_H, background: T.bg, color: T.text,
      display: 'flex', flexDirection: 'column', fontFamily: T.fontSans, overflow: 'hidden',
    }}>
      <Toolbar accent={accent} variant="C"/>
      <div style={{ flex: 1, display: 'flex', minHeight: 0, position: 'relative' }}>
        <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
          <CodeCanvas accent={accent} density={density} selectedId="useTodos"/>
          {/* dim overlay behind palette */}
          <div style={{
            position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.32)',
            pointerEvents: 'none',
          }}/>
          <AgentPalette accent={accent} top={64}/>
        </div>
        <div style={{ width: 300, background: T.panel, borderLeft: `1px solid ${T.line}`, display: 'flex', flexDirection: 'column' }}>
          <Inspector symbol={selected} accent={accent}/>
        </div>
      </div>
    </div>
  );
}

// Variant D — Inline popover on canvas (no persistent agent panel)
function VariantD({ accent, density }) {
  const selected = SAMPLE.symbols.find(s => s.id === 'TodoItem');
  // Position popover below the TodoItem node: col 1, row 1 → x=48+280, y=48+96
  const nodeX = 48 + 1 * 280;
  const nodeY = 48 + 1 * 96;
  const popX = nodeX + 240 + 16;
  const popY = nodeY;

  return (
    <div style={{
      width: BOARD_W, height: BOARD_H, background: T.bg, color: T.text,
      display: 'flex', flexDirection: 'column', fontFamily: T.fontSans, overflow: 'hidden',
    }}>
      <Toolbar accent={accent} variant="D"/>
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* left rail — icon-only nav */}
        <div style={{
          width: 48, background: T.panel, borderRight: `1px solid ${T.line}`,
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          padding: '10px 0', gap: 4,
        }}>
          {[
            {n:'◎', active: true},
            {n:'≡'}, {n:'⌕'}, {n:'⟲'}, {n:'⚙'},
          ].map((r, i) => (
            <div key={i} style={{
              width: 32, height: 32, borderRadius: 3,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: r.active ? T.panel2 : 'transparent',
              color: r.active ? accent : T.textDim,
              fontSize: 16, fontFamily: T.fontMono, cursor: 'pointer',
              border: `1px solid ${r.active ? T.line : 'transparent'}`,
            }}>{r.n}</div>
          ))}
          <div style={{ flex: 1 }}/>
          <div style={{
            width: 28, height: 28, borderRadius: 999, background: accent,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: T.bgDeep, fontFamily: T.fontMono, fontSize: 11, fontWeight: 600,
          }}>U</div>
        </div>

        <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
          <CodeCanvas accent={accent} density={density} selectedId="TodoItem"/>
          <AgentInlinePopover accent={accent} top={popY - 4} left={popX} targetSymbol={selected}/>

          {/* hint pill */}
          <div style={{
            position: 'absolute', top: 14, left: '50%', transform: 'translateX(-50%)',
            padding: '4px 10px', borderRadius: 999,
            background: T.panel, border: `1px solid ${T.line}`,
            fontFamily: T.fontMono, fontSize: 10.5, color: T.textMid,
            display: 'flex', gap: 8, alignItems: 'center',
          }}>
            <span style={{ width: 4, height: 4, borderRadius: 999, background: accent }}/>
            <span>hover a symbol · press <span style={{ color: T.text }}>A</span> to ask</span>
          </div>
        </div>

        <div style={{ width: 280, background: T.panel, borderLeft: `1px solid ${T.line}`, display: 'flex', flexDirection: 'column' }}>
          <Inspector symbol={selected} accent={accent} compact/>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { VariantA, VariantB, VariantC, VariantD, BOARD_W, BOARD_H });
