/* ══════════════════════════════════════════════════════════════
   battle-ui.js  –  shared rendering helpers
   Exposes a single global  BattleUI  object.
   ══════════════════════════════════════════════════════════════ */
const BattleUI = (() => {
    // ─── constants ──────────────────────────────────────────
    const SP = 'https://play.pokemonshowdown.com/sprites';

    const NODE_W    = 120;
    const NODE_H    = 95;
    const NODE_GAP_X = 20;
    const NODE_GAP_Y = 14;
    const PAD_LEFT  = 24;
    const PAD_TOP   = 24;
    const LANE_COLORS = [
        '#70a0ff','#b090ff','#70e080','#f0d070',
        '#ff7088','#70d0e0','#ffa070','#f0a0c0'
    ];

    // ─── sprite URLs ────────────────────────────────────────
    function sprite(speciesId, front) {
        return `${SP}/${front ? 'ani' : 'ani-back'}/${speciesId}.gif`;
    }
    function miniSprite(speciesId) {
        return `${SP}/gen5/${speciesId}.png`;
    }

    // ─── API ────────────────────────────────────────────────
    async function api(path, body) {
        const opts = body
            ? { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) }
            : {};
        return (await fetch('/api/' + path, opts)).json();
    }

    // ─── Toast ──────────────────────────────────────────────
    let _toastTimer;
    function toast(msg, type) {
        const t = document.getElementById('toast');
        if (!t) return;
        t.textContent = msg;
        t.className = 'toast ' + type;
        clearTimeout(_toastTimer);
        _toastTimer = setTimeout(() => { t.className = 'toast'; }, 4500);
    }

    // ─── Tree layout ────────────────────────────────────────
    /*
     * currentBattleId – if provided only THAT battle's current
     *                   turn node gets the .current highlight.
     *                   If null every battle highlights its own
     *                   current turn (used by the manager view).
     */
    function buildTreeLayout(battles, currentBattleId) {
        const ids = Object.keys(battles);
        if (!ids.length) return { nodes:[], connections:[], width:0, height:0 };

        ids.sort((a,b) => (battles[a].timelineNum||1) - (battles[b].timelineNum||1));

        const parent = {}, branchTurn = {};
        ids.forEach(id => {
            const lin = battles[id].lineage;
            if (lin && battles[lin.parentId]) {
                parent[id]     = lin.parentId;
                branchTurn[id] = lin.fromTurn;
            } else {
                parent[id] = null;
            }
        });

        const col = {};
        ids.forEach(id => { col[id] = (battles[id].timelineNum || 1) - 1; });

        const allTurns = new Set();
        ids.forEach(id => {
            const b = battles[id];
            (b.turnHistory || []).forEach(t => allTurns.add(t.turn));
            allTurns.add(b.turn);
        });
        const turnList  = [...allTurns].sort((a,b) => a - b);
        const turnToRow = {};
        turnList.forEach((t, i) => { turnToRow[t] = i; });

        // ── nodes ──
        const nodes = [];
        ids.forEach(id => {
            const b           = battles[id];
            const timelineNum = b.timelineNum || 1;
            const turns       = [...new Set([
                ...(b.turnHistory || []).map(t => t.turn),
                b.turn
            ])].sort((a,b) => a - b);

            turns.forEach(turn => {
                const th      = (b.turnHistory || []).find(t => t.turn === turn);
                const row     = turnToRow[turn];
                const c       = col[id];
                const isFirst = turn === turns[0];
                const isBranch = parent[id] !== null && isFirst;

                nodes.push({
                    id, timelineNum, turn,
                    coord : `${timelineNum}-${turn}`,
                    x     : PAD_LEFT + c * (NODE_W + NODE_GAP_X),
                    y     : PAD_TOP  + row * (NODE_H + NODE_GAP_Y),
                    col: c, row,
                    p1Active : th?.p1Active || null,
                    p2Active : th?.p2Active || null,
                    isCurrent: currentBattleId
                        ? (id === currentBattleId && turn === b.turn)
                        : (turn === b.turn),
                    ended    : b.ended,
                    isFirst, isBranch,
                    branchFrom: isBranch ? {
                        parentId           : parent[id],
                        parentTimelineNum  : battles[parent[id]]?.timelineNum || 1,
                        turn               : branchTurn[id],
                    } : null,
                    color: LANE_COLORS[c % LANE_COLORS.length],
                });
            });
        });

        // ── connections ──
        const connections = [];

        // vertical lines within each timeline
        ids.forEach(id => {
            const bn = nodes.filter(n => n.id === id).sort((a,b) => a.turn - b.turn);
            for (let i = 0; i < bn.length - 1; i++) {
                connections.push({
                    type  : 'vertical',
                    x1: bn[i].x   + NODE_W/2,  y1: bn[i].y   + NODE_H,
                    x2: bn[i+1].x + NODE_W/2,  y2: bn[i+1].y,
                    color : bn[i].color,
                });
            }
        });

        // curved branch lines
        ids.forEach(id => {
            if (parent[id] === null) return;
            const pNode = nodes.find(n => n.id === parent[id] && n.turn === branchTurn[id]);
            const cNode = nodes.find(n => n.id === id && n.isFirst);
            if (pNode && cNode) {
                connections.push({
                    type        : 'branch',
                    x1: pNode.x + NODE_W/2,  y1: pNode.y + NODE_H/2,
                    x2: cNode.x + NODE_W/2,  y2: cNode.y + NODE_H/2,
                    color       : cNode.color,
                    parentColor : pNode.color,
                });
            }
        });

        const maxCol = Math.max(...nodes.map(n => n.col), 0);
        const maxRow = Math.max(...nodes.map(n => n.row), 0);
        return {
            nodes, connections,
            width  : PAD_LEFT * 2 + (maxCol + 1) * (NODE_W + NODE_GAP_X),
            height : PAD_TOP  * 2 + (maxRow + 1) * (NODE_H + NODE_GAP_Y),
        };
    }

    /*
     * Populate a tree section that already exists in the DOM.
     *   container   – the outer .tree-container div
     *   svg         – the <svg class="tree-svg"> element
     *   nodesDiv    – the .tree-nodes div
     *   battles     – full battles map  { id: battleState }
     *   currentBattleId – see buildTreeLayout
     *   onNodeClick – optional  (node) => {}   makes nodes clickable
     */
    function renderTree(container, svg, nodesDiv, battles, currentBattleId, onNodeClick) {
        const layout = buildTreeLayout(battles, currentBattleId);

        if (!layout.nodes.length) {
            container.style.width  = '0';
            container.style.height = '0';
            svg.innerHTML      = '';
            nodesDiv.innerHTML = '';
            return;
        }

        container.style.width  = layout.width  + 'px';
        container.style.height = layout.height + 'px';
        svg.setAttribute('width',  layout.width);
        svg.setAttribute('height', layout.height);
        svg.innerHTML      = '';
        nodesDiv.innerHTML = '';

        // ── connections ──
        layout.connections.forEach(conn => {
            if (conn.type === 'vertical') {
                const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                line.setAttribute('x1', conn.x1); line.setAttribute('y1', conn.y1);
                line.setAttribute('x2', conn.x2); line.setAttribute('y2', conn.y2);
                line.setAttribute('stroke', conn.color);
                line.setAttribute('stroke-width', '3');
                line.setAttribute('stroke-linecap', 'round');
                svg.appendChild(line);
            } else {
                // curved branch
                const midY = (conn.y1 + conn.y2) / 2;
                const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                path.setAttribute('d',
                    `M ${conn.x1} ${conn.y1} C ${conn.x1} ${midY}, ${conn.x2} ${midY}, ${conn.x2} ${conn.y2}`);
                path.setAttribute('stroke', conn.color);
                path.setAttribute('stroke-width', '3');
                path.setAttribute('fill', 'none');
                path.setAttribute('stroke-linecap', 'round');
                path.setAttribute('stroke-dasharray', '8 4');
                svg.appendChild(path);

                const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                circle.setAttribute('cx', conn.x1); circle.setAttribute('cy', conn.y1);
                circle.setAttribute('r', '6');
                circle.setAttribute('fill', conn.parentColor);
                circle.setAttribute('stroke', conn.color);
                circle.setAttribute('stroke-width', '2');
                svg.appendChild(circle);
            }
        });

        // ── node cards ──
        layout.nodes.forEach(node => {
            const el = document.createElement('div');
            el.className = 'tree-node' + (node.isCurrent ? ' current' : '');
            el.style.left       = node.x + 'px';
            el.style.top        = node.y + 'px';
            el.style.borderColor = node.isCurrent ? 'var(--accent2)' : node.color;

            let branchTag = '';
            if (node.isBranch && node.branchFrom) {
                branchTag = `<div class="node-branch-tag">from ${node.branchFrom.parentTimelineNum}-${node.branchFrom.turn}</div>`;
            }

            const p1Html = node.p1Active ? renderNodePoke(node.p1Active) : '<div class="node-poke"><span class="node-poke-name">—</span></div>';
            const p2Html = node.p2Active ? renderNodePoke(node.p2Active) : '<div class="node-poke"><span class="node-poke-name">—</span></div>';

            el.innerHTML = `
                ${branchTag}
                <div class="node-coord-bar">
                    <span class="node-coord">${node.coord}</span>
                    ${node.isFirst ? `<span class="node-timeline-label">T${node.timelineNum}</span>` : ''}
                </div>
                <div class="node-pokemon">
                    ${p1Html}
                    <span class="node-vs">vs</span>
                    ${p2Html}
                </div>
            `;

            if (onNodeClick) {
                el.classList.add('clickable');
                el.onclick = () => onNodeClick(node);
            }

            nodesDiv.appendChild(el);
        });
    }

    // ─── Node pokemon mini HTML ─────────────────────────────
    function renderNodePoke(poke) {
        const hpPct   = poke.maxhp > 0 ? Math.round((poke.hp / poke.maxhp) * 100) : 0;
        const hpClass = hpPct > 50 ? 'green' : hpPct > 20 ? 'yellow' : 'red';
        const statusHtml = poke.status
            ? `<span class="node-status ${poke.status}">${poke.status}</span>` : '';
        return `
            <div class="node-poke">
                <img class="node-poke-sprite" src="${miniSprite(poke.species)}"
                     onerror="this.style.visibility='hidden'" alt="">
                <span class="node-poke-name">${poke.name || '?'}${statusHtml}</span>
                <div class="node-hp-bar">
                    <div class="node-hp-fill ${hpClass}" style="width:${hpPct}%"></div>
                </div>
            </div>`;
    }

    // ─── Scene ──────────────────────────────────────────────
    /*
     * Builds the pokemon-battle scene inside sceneEl.
     *   sides      – { p1: sideData, p2: sideData }
     *   playerSide – 'p1'|'p2'|null
     *                When set, that trainer-bar gets .own and
     *                the opponent's HP shows as a percentage only.
     */
    function renderScene(sceneEl, sides, playerSide) {
        sceneEl.innerHTML = '';

        for (const sid of ['p1','p2']) {
            const s = sides[sid];
            if (!s) continue;
            const bar = document.createElement('div');
            bar.className = `trainer-bar ${sid}`;
            if (playerSide && sid === playerSide) bar.classList.add('own');

            const alive   = (s.active?.filter(p => p && !p.fainted).length || 0) + (s.bench?.length || 0);
            const fainted = s.fainted?.length || 0;
            bar.innerHTML =
                `<span>${s.name}</span>
                 <div class="pokeballs">
                     ${'<div class="pball alive"></div>'.repeat(alive)}
                     ${'<div class="pball fnt"></div>'.repeat(fainted)}
                 </div>`;
            sceneEl.appendChild(bar);
        }

        for (const sid of ['p1','p2']) {
            const s = sides[sid];
            if (!s || !s.active?.length) continue;
            const p = s.active[0];
            if (!p) continue;

            const area = document.createElement('div');
            area.className = `poke-area ${sid}`;
            const front       = sid === 'p2';
            const showExactHp = !playerSide || sid === playerSide;

            if (sid === 'p2') {
                area.appendChild(createStatbar(p, sid, showExactHp));
                area.appendChild(createSprite(p, front));
            } else {
                area.appendChild(createSprite(p, front));
                area.appendChild(createStatbar(p, sid, showExactHp));
            }
            sceneEl.appendChild(area);
        }
    }

    // ─── Statbar element ────────────────────────────────────
    function createStatbar(p, sid, showExactHp) {
        const el    = document.createElement('div');
        el.className = `statbar ${sid}`;

        const pct   = p.hpPct || (p.maxhp > 0 ? Math.round((p.hp / p.maxhp) * 100) : 0);
        const hcls  = pct > 50 ? 'green' : pct > 20 ? 'yellow' : 'red';
        const g     = p.gender === 'M' ? '<span class="g M">♂</span>'
                    : p.gender === 'F' ? '<span class="g F">♀</span>' : '';
        const st    = p.status ? `<span class="st-icon ${p.status}">${p.status}</span>` : '';

        let boosts = '';
        if (p.boosts) {
            for (const [s, v] of Object.entries(p.boosts)) {
                if (v > 0)  boosts += `<span class="boost up">+${v} ${s}</span>`;
                else if (v < 0) boosts += `<span class="boost dn">${v} ${s}</span>`;
            }
        }

        el.innerHTML = `
            <div class="sb-name">${p.name} ${g} <span class="lvl">L${p.level}</span> ${st}</div>
            <div class="hp-track"><div class="hp-fill ${hcls}" style="width:${pct}%"></div></div>
            <div class="hp-num">${showExactHp ? `${p.hp}/${p.maxhp}` : pct + '%'}</div>
            ${boosts ? `<div class="boosts">${boosts}</div>` : ''}`;
        return el;
    }

    // ─── Sprite element ─────────────────────────────────────
    function createSprite(p, front) {
        const img     = document.createElement('img');
        img.className = `sprite ${front ? 'p2' : 'p1'}${p.fainted ? ' fnt' : ''}`;
        img.src       = sprite(p.speciesId, front);
        img.onerror   = () => { img.src = miniSprite(p.speciesId); };
        return img;
    }

    // ─── Controls panel ─────────────────────────────────────
    /*
     * Returns a fully built .controls div for one side.
     *   bid            – battle id string
     *   sid            – 'p1' | 'p2'
     *   side           – side data object
     *   battle         – full battle state
     *   onSubmitChoice – (choiceString) => {}
     *   onOpenTT       – () => {}   (omit to hide the TT button)
     *   isPlayer       – if true uses friendlier labels
     */
    function renderControlsPanel(bid, sid, side, battle, onSubmitChoice, onOpenTT, isPlayer) {
        const panel = document.createElement('div');
        panel.className = 'controls';

        const canAct      = !battle.ended && side.requestState === 'move'   && !side.choiceDone;
        const needsSwitch = !battle.ended && side.requestState === 'switch' && !side.choiceDone;
        const waiting     = !battle.ended && side.choiceDone;
        const poke        = side.active?.[0];
        const isQueued    = battle.pendingTransfers && battle.pendingTransfers[sid];

        // ── badge ──
        let badge = '';
        if (!battle.ended) {
            if (isQueued)     badge = `<span class="badge queued">⏳ → ${battle.pendingTransfers[sid].targetCoord}</span>`;
            else if (waiting) badge = isPlayer
                ? '<span class="badge ready">Waiting for opponent…</span>'
                : '<span class="badge ready">Waiting…</span>';
            else if (needsSwitch) badge = '<span class="badge wait">Must Switch!</span>';
            else if (canAct)       badge = isPlayer
                ? '<span class="badge wait">Your Turn!</span>'
                : '<span class="badge wait">Your Move</span>';
        }

        const title = isPlayer
            ? `Your Pokémon: ${poke?.name || '—'}`
            : `${sid.toUpperCase()}: ${side.name}`;

        panel.innerHTML = `<div class="ctrl-head">
            <span class="ctrl-title">${title}</span>${badge}</div>`;

        // ── move buttons ──
        if (canAct && poke && !poke.fainted && !isQueued) {
            const mv = document.createElement('div');
            mv.className = 'moves';
            for (const m of poke.moves) {
                const btn     = document.createElement('button');
                btn.className = `mbtn t-${m.type}`;
                btn.disabled  = m.disabled || m.pp <= 0;
                btn.innerHTML = `${m.name}<span class="pp">${m.pp}/${m.maxpp}</span>`;
                btn.onclick   = () => onSubmitChoice(`move ${m.id}`);
                mv.appendChild(btn);
            }
            panel.appendChild(mv);
        }

        // ── switch list ──
        if ((canAct || needsSwitch) && side.bench?.length && !isQueued) {
            const sw = document.createElement('div');
            sw.className = 'switch-list';
            sw.innerHTML = `<div class="switch-lbl">${isPlayer ? 'Switch Pokémon:' : 'Switch:'}</div>`;
            for (const bp of side.bench) {
                const row     = document.createElement('div');
                row.className = 'switch-row';
                row.innerHTML = `
                    <img class="sw-sprite" src="${sprite(bp.speciesId, true)}"
                         onerror="this.src='${miniSprite(bp.speciesId)}'" />
                    <div class="sw-info">
                        <div class="sw-name">${bp.name}</div>
                        <div class="sw-hp">${bp.hp}/${bp.maxhp} (${bp.hpPct}%)</div>
                    </div>`;
                const btn     = document.createElement('button');
                btn.className = 'sw-btn';
                btn.textContent = 'Switch';
                btn.onclick   = () => onSubmitChoice(`switch ${bp.teamIndex}`);
                row.appendChild(btn);
                sw.appendChild(row);
            }
            panel.appendChild(sw);
        }

        // ── time-transfer button ──
        if (canAct && poke && !poke.fainted && !isQueued && onOpenTT) {
            const tt = document.createElement('div');
            tt.className = 'tt-section';
            tt.innerHTML = '<div class="tt-label"><span>⏳</span> Time Transfer</div>';
            const btn     = document.createElement('button');
            btn.className = 'tt-btn';
            btn.innerHTML = '↩️ Send to Another Coordinate';
            btn.onclick   = onOpenTT;
            tt.appendChild(btn);
            panel.appendChild(tt);
        }

        return panel;
    }

    // ─── Battle log ─────────────────────────────────────────
    function renderLog(lines, containerEl) {
        containerEl.innerHTML = '';
        for (const line of (lines || [])) {
            const el    = document.createElement('div');
            el.className = 'lg';

            if      (line.startsWith('|turn|'))     { el.className += ' turn';  el.textContent = `═ Turn ${line.split('|')[2]} ═`; }
            else if (line.startsWith('|move|'))     { el.className += ' move';  const p = line.split('|'); el.textContent = `${p[2]} used ${p[3]}!`; }
            else if (line.startsWith('|-damage|'))  { el.className += ' dmg';   const p = line.split('|'); el.textContent = `${p[2]} took damage (${p[3]})`; }
            else if (line.startsWith('|-heal|'))    { el.className += ' heal';  const p = line.split('|'); el.textContent = `${p[2]} healed (${p[3]})`; }
            else if (line.startsWith('|faint|'))    { el.className += ' fnt';   el.textContent = `${line.split('|')[2]} fainted!`; }
            else if (line.startsWith('|switch|') || line.startsWith('|drag|'))
                                                    { el.className += ' sw';    el.textContent = `${line.split('|')[2]} was sent out!`; }
            else if (line.startsWith('|-boost|') || line.startsWith('|-unboost|'))
                                                    { el.className += ' boost';
                                                      const p = line.split('|');
                                                      el.textContent = `${p[2]}'s ${p[3]} ${line.includes('-boost|') ? 'rose' : 'fell'}!`; }
            else if (line.startsWith('|-status|'))  { el.className += ' st';    const p = line.split('|'); el.textContent = `${p[2]} is ${p[3]}!`; }
            else if (line.startsWith('|win|'))      { el.className += ' win';   el.textContent = `${line.split('|')[2]} wins!`; }
            else if (line.startsWith('|-message|') || line.startsWith('|message|'))
                                                    { const msg = line.split('|').slice(2).join(' ');
                                                      el.className += (msg.includes('Timeline') || msg.includes('traveled')
                                                          || msg.includes('branched') || msg.includes('arrived')) ? ' tl' : ' msg';
                                                      el.textContent = msg; }
            else if (line.startsWith('|'))          { const c = line.replace(/\|/g,' ').trim();
                                                      if (!c || c === 'split' || c.startsWith('t:')) continue;
                                                      el.textContent = c; }
            else continue;

            containerEl.appendChild(el);
        }
        containerEl.scrollTop = containerEl.scrollHeight;
    }

    // ─── Transfer-target modal population ───────────────────
    /*
     * Populates the shared #ttModal with transfer targets.
     * The page is still responsible for wiring #btnConfirm's
     * onclick to its own confirmTT() so it can supply the
     * correct battleId / side.  Call getTransferTarget() from
     * there to retrieve the user's selection.
     */
    let _ttTarget = null;

    async function populateTransferModal(poke, timelineNum, turn, sourceGlobalId) {
        _ttTarget = null;

        document.getElementById('ttInfo').innerHTML = `
            <img class="modal-sprite" src="${sprite(poke.speciesId, true)}"
                 onerror="this.src='${miniSprite(poke.speciesId)}'" />
            <div class="modal-info-text">
                <strong>${poke.name}</strong> (${poke.species})<br>
                HP: ${poke.hp}/${poke.maxhp} (${poke.hpPct}%)<br>
                Current: <span class="modal-current-coord">${timelineNum}-${turn}</span>
            </div>`;

        const { targets } = await api(
            'transfer-targets' +
            (sourceGlobalId ? '?battleId=' + encodeURIComponent(sourceGlobalId) : '')
        );
        const container   = document.getElementById('ttTargets');
        container.innerHTML = '';

        // group by timeline
        const byTL = {};
        for (const t of targets) {
            (byTL[t.timelineNum] = byTL[t.timelineNum] || []).push(t);
        }
        const tlNums = Object.keys(byTL).map(Number).sort((a,b) => a - b);

        if (!tlNums.length) {
            container.innerHTML = '<p style="color:var(--text-dim)">No valid targets (need past turns in active timelines).</p>';
        } else {
            for (const tNum of tlNums) {
                const section = document.createElement('div');
                section.className = 'target-section';
                section.innerHTML = `<div class="target-section-title">
                    <span class="timeline-num">T${tNum}</span> Timeline ${tNum}</div>`;

                const grid = document.createElement('div');
                grid.className = 'target-grid';

                for (const t of byTL[tNum]) {
                    const btn     = document.createElement('button');
                    btn.className = 'target-btn';

                    const p1Hp = t.p1Active?.maxhp > 0 ? Math.round((t.p1Active.hp / t.p1Active.maxhp) * 100) : 0;
                    const p2Hp = t.p2Active?.maxhp > 0 ? Math.round((t.p2Active.hp / t.p2Active.maxhp) * 100) : 0;
                    const hpCls = v => v > 50 ? 'green' : v > 20 ? 'yellow' : 'red';

                    btn.innerHTML = `
                        <div class="target-coord">${t.coordinate}</div>
                        <div class="target-info">${t.p1Active?.name || '?'} vs ${t.p2Active?.name || '?'}</div>
                        <div class="target-hp">
                            <span class="target-hp-item"><span class="target-hp-dot ${hpCls(p1Hp)}"></span>${p1Hp}%</span>
                            <span class="target-hp-item"><span class="target-hp-dot ${hpCls(p2Hp)}"></span>${p2Hp}%</span>
                        </div>`;

                    btn.onclick = () => {
                        document.querySelectorAll('.target-btn').forEach(b => b.classList.remove('sel'));
                        btn.classList.add('sel');
                        _ttTarget = t;
                        _syncConfirmBtn();
                    };
                    grid.appendChild(btn);
                }
                section.appendChild(grid);
                container.appendChild(section);
            }
        }

        _syncConfirmBtn();
        document.getElementById('ttModal').classList.add('open');
    }

    function _syncConfirmBtn() {
        const btn  = document.getElementById('btnConfirm');
        const span = document.getElementById('confirmCoord');
        if (btn)  btn.disabled  = !_ttTarget;
        if (span) span.textContent = _ttTarget ? _ttTarget.coordinate : '—';
    }

    function getTransferTarget()  { return _ttTarget; }
    function closeTransferModal() {
        document.getElementById('ttModal').classList.remove('open');
        _ttTarget = null;
    }

    // ─── public surface ─────────────────────────────────────
    return {
        sprite, miniSprite, api, toast,
        renderTree, renderNodePoke,
        createStatbar, createSprite, renderScene,
        renderControlsPanel,
        renderLog,
        populateTransferModal, closeTransferModal, getTransferTarget,
    };
})();