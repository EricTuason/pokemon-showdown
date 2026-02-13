# Timeline Visualizer & Transfer UI Implementation Guide

## Overview

The timeline branching system is server-side complete. This guide explains how to implement the **client-side UI** for:
1. **Timeline Visualizer** - displays branches and coordinates
2. **Transfer UI** - allows sending Pokémon to other timelines

## Server-Side Messages

The server sends timeline data via these messages in the battle stream:

### Message Format: `|timeline|GLOBALID`
Sent during `>start` to indicate which timeline is active.

Example:
```
|timeline|battle-123:1
```

### Message Format: `|timenodes|JSON`
Sent during `>start` with full timeline structure.

Example:
```
|timenodes|{"battle-123:1":{"timelineNum":1,"turn":0},"battle-123:2":{"timelineNum":2,"turn":0,"parentId":"battle-123:1"}}
```

## Client Architecture

Pokemon Showdown has a separate client repository:
- **Server repo**: https://github.com/smogon/pokemon-showdown (this one)
- **Client repo**: https://github.com/smogon/pokemon-showdown-client

The client-side UI implementation should go in the **pokemon-showdown-client** repo.

## Implementation Steps

### 1. Parse Timeline Messages

In the battle message parser (typically `battle-log.ts` or equivalent):

```typescript
// In battle stream message handler
if (msgType === 'timeline') {
    const timelineId = msgData;
    BattleData.setCurrentTimeline(timelineId);
}

if (msgType === 'timenodes') {
    const branches = JSON.parse(msgData);
    BattleData.setTimelineBranches(branches);
}
```

### 2. Store Timeline State

Create a timeline data store:

```typescript
interface TimelineNode {
    timelineNum: number;
    turn: number;
    parentId?: string;
    fromTurn?: number;
}

class BattleTimelineData {
    private currentTimelineId: string;
    private branches: Record<string, TimelineNode> = {};

    setCurrentTimeline(id: string) {
        this.currentTimelineId = id;
    }

    setTimelineBranches(data: Record<string, TimelineNode>) {
        this.branches = data;
    }

    getBranches() {
        return this.branches;
    }

    getCurrentTimelineNum(): number {
        const current = this.branches[this.currentTimelineId];
        return current?.timelineNum || 1;
    }
}
```

### 3. UI Component: Timeline Visualizer

Create a component to display timeline branches:

```typescript
// timeline-visualizer.ts

class TimelineVisualizer {
    private container: HTMLElement;
    private colors = [
        '#70a0ff', '#b090ff', '#70e080', '#f0d070',
        '#ff7088', '#70d0e0', '#ffa070', '#f0a0c0'
    ];

    constructor(containerElement: HTMLElement) {
        this.container = containerElement;
    }

    render(timelineData: TimelineData) {
        const branches = timelineData.getBranches();
        const currentId = timelineData.getCurrentTimelineId();

        // Group by timeline number
        const byTimeline = this.groupByTimelineNum(branches);
        
        const html = Array.from(byTimeline.entries())
            .map(([tNum, nodes], idx) => 
                this.renderTimelineColumn(tNum, nodes, currentId, this.colors[idx % 8])
            )
            .join('');

        this.container.innerHTML = html;
    }

    private groupByTimelineNum(
        branches: Record<string, TimelineNode>
    ): Map<number, Array<{ id: string; node: TimelineNode }>> {
        const map = new Map<number, Array<{ id: string; node: TimelineNode }>>();
        
        for (const [id, node] of Object.entries(branches)) {
            const tNum = node.timelineNum || 1;
            if (!map.has(tNum)) map.set(tNum, []);
            map.get(tNum)!.push({ id, node });
        }

        // Sort each timeline's nodes by turn
        for (const nodes of map.values()) {
            nodes.sort((a, b) => a.node.turn - b.node.turn);
        }

        return map;
    }

    private renderTimelineColumn(
        timelineNum: number,
        nodes: Array<{ id: string; node: TimelineNode }>,
        currentId: string,
        color: string
    ): string {
        const coordsHtml = nodes
            .map(({ id, node }) => `
                <div class="timeline-coord ${id === currentId ? 'current' : ''}" 
                     style="background-color: ${id === currentId ? color : 'transparent'};">
                    ${timelineNum}-${node.turn}
                </div>
            `)
            .join('');

        return `
            <div class="timeline-column" style="border-left-color: ${color};">
                <div class="timeline-label" style="color: ${color};">T${timelineNum}</div>
                ${coordsHtml}
            </div>
        `;
    }
}
```

### 4. UI Component: Transfer Button

Add transfer button to active Pokémon controls:

```typescript
// In the move/switch controls section of BattleScene

const transferBtn = document.createElement('button');
transferBtn.textContent = '⏳ Send Pokémon to Timeline...';
transferBtn.className = 'timeline-transfer-btn';
transferBtn.onclick = () => {
    const activePoke = BattleData.getCurrentPokemon();
    if (activePoke) {
        showTransferModal(activePoke);
    }
};

// Add button to controls container if timeline is active
if (BattleData.hasTimeline()) {
    controlsContainer.appendChild(transferBtn);
}
```

### 5. Transfer Modal

Create a modal for selecting transfer target:

```typescript
function showTransferModal(pokemon: Pokemon) {
    const modal = document.createElement('div');
    modal.className = 'transfer-modal';
    
    // Populate available targets
    const targets = getTransferTargets();
    const targetsHtml = targets
        .map(t => `
            <div class="transfer-target-btn" data-target="${t.coord}">
                <div class="target-coord">${t.coord}</div>
                <div class="target-players">
                    ${t.p1Name} vs ${t.p2Name}
                </div>
                <div class="target-hp">
                    ${t.p1Hp}% / ${t.p2Hp}%
                </div>
            </div>
        `)
        .join('');

    modal.innerHTML = `
        <div class="modal-content">
            <h3>${pokemon.name} → Transfer to</h3>
            <div class="targets-grid">
                ${targetsHtml}
            </div>
            <button onclick="confirmTransfer(event)">Transfer</button>
            <button onclick="closeModal()">Cancel</button>
        </div>
    `;

    document.body.appendChild(modal);
}
```

### 6. CSS Styles

```css
/* Timeline Visualizer */
.timeline-visualizer {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    padding: 8px;
    background: rgba(112,160,255,0.08);
    border-radius: 6px;
}

.timeline-column {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px 8px;
    border-left: 3px solid #70a0ff;
    border-radius: 4px;
    min-width: 70px;
}

.timeline-label {
    font-size: 10px;
    font-weight: 700;
    text-align: center;
    text-transform: uppercase;
}

.timeline-coord {
    padding: 3px 5px;
    background: rgba(255,255,255,0.05);
    border-radius: 2px;
    font-size: 10px;
    font-family: 'Roboto Mono', monospace;
    text-align: center;
    transition: all 0.15s;
}

.timeline-coord.current {
    font-weight: 700;
    box-shadow: 0 0 6px rgba(112,160,255,0.6);
    color: #1a1a2e;
}

/* Transfer Modal */
.transfer-modal {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0,0,0,0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
}

.modal-content {
    background: var(--surface);
    border-radius: 8px;
    padding: 20px;
    max-width: 600px;
    max-height: 80vh;
    overflow-y: auto;
}

.targets-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: 8px;
    margin: 15px 0;
}

.transfer-target-btn {
    padding: 10px;
    background: var(--surface2);
    border: 2px solid var(--overlay);
    border-radius: 6px;
    cursor: pointer;
    text-align: center;
    transition: all 0.15s;
    font-size: 11px;
}

.transfer-target-btn:hover {
    border-color: var(--accent);
    background: var(--overlay);
}

.transfer-target-btn.selected {
    border-color: var(--accent);
    background: rgba(176,144,255,0.2);
}

.target-coord {
    font-family: 'Roboto Mono', monospace;
    font-weight: 700;
    color: var(--accent3);
    margin-bottom: 4px;
}

.target-players {
    font-size: 10px;
    color: var(--text-dim);
    margin-bottom: 4px;
}

.target-hp {
    font-size: 9px;
    color: var(--text-dim);
}
```

## Integration Checklist

- [ ] Update battle stream message parser to handle `|timeline|` 
- [ ] Update battle stream message parser to handle `|timenodes|`
- [ ] Create `TimelineVisualizer` component
- [ ] Create `TransferUI` component and modal
- [ ] Add timeline visualizer to battle scene
- [ ] Add transfer button to active Pokémon controls
- [ ] Wire up transfer button to open modal
- [ ] Handle transfer target selection
- [ ] Send transfer request to server via appropriate protocol
- [ ] Style all new components to match Showdown theme
- [ ] Add timeline info to battle log messages

## Testing

To test the timeline visualizer:

1. Start a battle with `format.timeline = true`
2. Receive `|timeline|` and `|timenodes|` messages
3. Verify visualizer renders all timeline branches
4. Click transfer button
5. Select target coordinate
6. Verify transfer request is sent

## Notes

- Timeline data is only available for battles created with `format.timeline = true`
- The visualizer should auto-update when new branches are created
- Transfer targets are determined by the server's `getTransferTargets()` method
- All coordinates are in format `TIMELINE_NUM-TURN`
