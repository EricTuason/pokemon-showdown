# Implementation Checklist for Timeline Integration

## Completed ✅

- [x] Add `timeline?: boolean` to Format type (sim/dex-formats.ts)
- [x] Implement transfer validation - prevent last pokemon from transferring
- [x] Add duplicate pokemon detection in branch creation
- [x] Create MultiTimeBattleStream wrapper class (sim/multi-battle-stream.ts)
- [x] Verify transfer queueing already works correctly

## Remaining Work (Prioritized)

### Phase 1: Room-Battle Integration (CRITICAL)

**File: server/room-battle.ts**

#### 1. Constructor Modification (~line 545)
```typescript
// BEFORE:
this.stream = PM.createStream();

// AFTER:
const format = Dex.formats.get(options.format, true);
this.isTimelineBattle = !!format.timeline;
if (this.isTimelineBattle) {
    // Import at top: import { MultiTimeBattleStream } from '../sim/multi-battle-stream';
    const { MultiBattleManager } = require('../game-logic');
    const manager = new MultiBattleManager();
    this.stream = new MultiTimeBattleStream(manager);
    this.timelineManager = manager;
} else {
    this.stream = PM.createStream();
}
```

#### 2. Choose Method Modification (~line 620)
```typescript
// ADD to override choose():
if (this.isTimelineBattle && this.timelineManager) {
    // Parse timeline ID from data if present
    const [choice, rqid, timelineId] = data.split('|', 3);
    const side = `p${player.slot.slice(1)}` as SideID;
    const actualChoiceStr = timelineId ? `${choice}|${timelineId}` : choice;
    void this.stream.write(`>${player.slot} ${actualChoiceStr}`);
} else {
    // existing code
    void this.stream.write(`>${player.slot} ${choice}`);
}
```

#### 3. Receive Method Modification (~line 820)
```typescript
case 'update':
    for (const line of lines.slice(1)) {
        // ADD: Parse timeline messages
        if (line.startsWith('|timeline|')) {
            const timelineId = line.slice(10).trim();
            for (const player of this.players) {
                if (player.active) player.currentTimelineId = timelineId;
            }
        }
        if (line.startsWith('|timenodes|')) {
            const nodes = JSON.parse(line.slice(11));
            this.room.add(`|timenodes|${JSON.stringify(nodes)}`);
        }
        
        // existing code
        this.room.add(line);
    }
    break;
```

#### 4. Add Type Definitions (~line 470)
```typescript
export class RoomBattle extends RoomGame<RoomBattlePlayer> {
    // ... existing properties ...
    
    // ADD:
    isTimelineBattle: boolean = false;
    timelineManager?: any;  // TODO: Import MultiBattleManager type
    
    // ADD to RoomBattlePlayer:
    currentTimelineId?: string;
```

---

### Phase 2: "The Present" Rule Implementation

**File: game-logic/MultiBattleManager.js**

Add after `getTransferTargets()` method:
```javascript
/**
 * Get the "present" - the set of timelines with the lowest turn count.
 * These are the timelines closest to the current moment in time.
 */
getPresent(matchId = null) {
    const matchList = (matchId && this.matches.has(matchId))
        ? [this.matches.get(matchId)]
        : [...this.matches.values()];

    const presentTimelines = [];
    let minTurn = Infinity;

    for (const match of matchList) {
        for (const [, timeline] of match.timelines) {
            const turn = timeline.battle?.turn ?? 0;
            if (turn < minTurn) {
                minTurn = turn;
                presentTimelines.length = 0;
            }
            if (turn === minTurn) {
                presentTimelines.push(timeline);
            }
        }
    }

    return presentTimelines;
}
```

Update `getTransferTargets()` to mark present timelines:
```javascript
// At end of getTransferTargets(), after sorting:
const present = this.getPresent(matchId);
const presentIds = new Set(present.map(t => t.globalId));

for (const target of targets) {
    target.isPresent = presentIds.has(target.timelineId);
}

return targets;
```

---

### Phase 3: Client-Side Timeline Selector

**File: [Pokemon Showdown Client Directory]/battle.ts** or equivalent

Add timeline tracking:
```typescript
// Add to Battle class:
activeTimeline: string = '';
availableTimelines: any[] = [];

// Add handler for timeline messages:
case 'timeline':
    this.activeTimeline = args[1];
    this.updateTimelineDisplay();
    break;

case 'timenodes':
    this.availableTimelines = JSON.parse(args.join('|'));
    this.updateTimelineDisplay();
    break;
```

Add UI element (integrate into existing battle view):
```html
<!-- Add to battle scene -->
<div id="timeline-selector" class="battle-timeline-selector" style="display: none;">
    <label>Timeline: <span id="current-timeline">—</span></label>
    <button id="timeline-menu-btn" onclick="toggleTimelineMenu()">Select Timeline ▼</button>
    <div id="timeline-menu" class="timeline-menu" style="display: none;">
        <!-- Populated by JavaScript -->
    </div>
</div>
```

Update battle UI when timeline changes:
```typescript
updateTimelineDisplay() {
    if (!this.availableTimelines.length) return;
    
    const selector = document.getElementById('timeline-selector');
    selector.style.display = 'block';
    
    const current = document.getElementById('current-timeline');
    current.textContent = this.activeTimeline;
    
    const menu = document.getElementById('timeline-menu');
    menu.innerHTML = this.availableTimelines.nodes.map((node: any) => `
        <div class="timeline-item ${node.active ? 'active' : ''} ${node.isPresent ? 'present' : ''}">
            <button onclick="switchTimeline('${node.id}')">
                T${node.num}-${node.turn}
                ${node.isPresent ? ' [PRESENT]' : ''}
                ${node.ended ? ' [ENDED]' : ''}
            </button>
        </div>
    `).join('');
}

switchTimeline(timelineId: string) {
    // Send request to server to switch active timeline
    this.room.send(`/timeline ${timelineId}`);
    // Or via battle command if implemented in protocol
}
```

---

### Phase 4: 4-Player Support

**File: game-logic/MultiBattleManager.js**

Update `_wireTimeline()` to support p3 and p4:
```javascript
_wireTimeline(match, parentNum = null, fromTurn = null) {
    // ... existing code ...
    
    // Update to handle 4 players:
    const players = match.gameType === 'multi' ? ['p1', 'p2', 'p3', 'p4'] : ['p1', 'p2'];
    
    for (const sideId of players) {
        const playerData = match.originalTeams[sideId];
        const side = timeline.battle[sideId];
        if (!side || !playerData) continue;
        
        // existing team setup code
    }
}
```

---

## Testing Checklist

### Unit Tests
- [ ] Transfer validation prevents last pokemon
- [ ] Duplicate pokemon detection works
- [ ] getPresent() returns correct timelines
- [ ] Transfer queueing waits for both players

### Integration Tests
- [ ] Timeline format can be created without errors
- [ ] MultiTimeBattleStream accepts >start command
- [ ] RoomBattle switches to timeline mode for timeline formats
- [ ] |timeline| and |timenodes| messages are sent
- [ ] Client receives and parses timeline messages

### Functional Tests
- [ ] Can select and switch between timelines
- [ ] "Present" timelines are highlighted
- [ ] 4-player battles create and manage timelines correctly
- [ ] Battle ends when opponent has no pokemon left in any timeline

---

## Common Pitfalls to Avoid

1. **Type Safety**: Remember to import MultiBattleManager type properly
2. **Message Parsing**: Timeline ID must be stripped from choice before passing to battle
3. **State Duplication**: Don't clone pokemon unnecessarily - use references where possible
4. **UI Updates**: Timeline selector must appear/disappear based on format
5. **Error Handling**: All manager calls should return success/error objects

---

## Documentation Files Created

- [x] TIMELINE_INTEGRATION.md - High-level overview
- [x] IMPLEMENTATION_CHECKLIST.md - This file
- [x] sim/multi-battle-stream.ts - Core bridge implementation
