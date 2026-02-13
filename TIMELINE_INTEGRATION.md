# Timeline Battle System Integration Guide

## Overview
This document describes the integration of the Multi-Timeline Battle System into Pokémon Showdown's existing server infrastructure.

## Priority Features (In Order)

### 1. ✅ Prevent Last Pokémon Transfer
**Status**: IMPLEMENTED
- Added validation in `MultiBattleManager.queueTransfer()`
- Counts non-fainted Pokémon on side
- Rejects transfer if it would leave the side with 0 Pokémon
- Error message: "Cannot transfer your last Pokémon"

### 2. ✅ Fix Pokemon Deletion Bug
**Status**: IMPLEMENTED
- Added defensive check in `_createBranch()` to detect duplicate insertions
- Stores pokemon reference before modifying active slot
- Prevents double-insertion of same pokemon into destination timeline
- Added logging via `sourcePokeIdForLogging` for debugging

### 3. ⏳ Transfer Queueing (Already Working)
**Status**: VERIFIED
- Transfers are already queued in `pendingTransfers` map
- Flushed only after `battle.allChoicesDone()` in `submitChoice()`
- Both players must choose before transfers execute
- Battle halting was caused by UI issue, not code logic

### 4. ⏳ "The Present" Rule
**Status**: NOT STARTED - DESIGN NEEDED
- Define "the present" = timelines with minimum turn count
- Update transfer targets to highlight "present" timelines
- Modify UI to show which timelines are "present"
- May need helper: `getPresent(match) → Timeline[]`

### 5. ⏳ Win Condition
**Status**: VERIFY
- Current: First to have opponent `pokemonLeft <= 0` wins
- Already implemented in `battle.ts` via `battle.win()`
- Behavior should carry over; needs testing with multiple timelines

### 6. ⏳ 4-Player Support
**Status**: NOT STARTED
- Requires support for gameType='ffa' or 'multi' in timeline mode
- Update `MultiBattleManager._wireTimeline()` for p3, p4
- Test team transfers with 4 players
- May need custom branching logic for team interactions

## Architecture

### File Structure
```
sim/
  multi-battle-stream.ts       ← NEW: BattleStream wrapper for MultiBattleManager
  dex-formats.ts               ← MODIFIED: Added timeline?: boolean property

game-logic/
  MultiBattleManager.js        ← MODIFIED: Add transfer validation & dedup logic
  Match.js
  Timeline.js
  helpers.js

server/
  room-battle.ts               ← TODO: Modify to use MultiTimeBattleStream
```

### Key Classes

#### MultiTimeBattleStream (sim/multi-battle-stream.ts)
Bridges `MultiBattleManager` to Pokemon Showdown's battle system.

**Responsibilities:**
- Emulate `BattleStream` interface
- Parse incoming commands (`>start`, `>player`, `>p1 move`, etc.)
- Route commands to correct timeline via `MultiBattleManager`
- Emit protocol messages with timeline metadata
- Manage timeline list for UI

**Key Methods:**
```typescript
_writeLine(type: string, message: string)
  case 'start': creates Match via manager
  case 'player': routes to timeline side
  case 'p1'|'p2'|'p3'|'p4': submitChoice via manager

_getTimelineNodes(): returns timeline tree for UI
```

#### MultiTimeBattle (nested in MultiTimeBattleStream)
Thin wrapper exposing single Battle interface to RoomBattle.

**Properties:**
- `currentTimelineId`: active timeline for UI
- `currentTimeline`: active Timeline object
- Delegates `.battle`, `.turn`, `.ended`, etc. to current timeline

### Protocol Messages

**Server → Client:**
```
|timeline|<matchId>:<timelineNum>    // Current active timeline
|timenodes|{"nodes":[...]}           // Available timelines tree
```

**Sample timenodes:**
```json
{
  "nodes": [
    { "id": "abc:1", "num": 1, "turn": 5, "parent": null, "branchTurn": null, "active": true, "ended": false },
    { "id": "abc:2", "num": 2, "turn": 5, "parent": "abc:1", "branchTurn": 5, "active": false, "ended": false }
  ]
}
```

## Integration Steps

### Phase 1: Core Plumbing
1. ✅ Add `timeline?: boolean` to Format type definition
2. ✅ Add transfer validation to prevent last pokemon
3. ✅ Add duplicate pokemon detection in branch creation
4. ⏳ Create `MultiTimeBattleStream` in `sim/multi-battle-stream.ts`
5. ⏳ Modify `server/room-battle.ts` to detect & use timeline mode

### Phase 2: Room-Battle Integration
1. Detect timeline format in `RoomBattle` constructor
2. Create `MultiTimeBattleStream` instead of `BattleStream`
3. Update `choose()` method to parse timeline ID from choice
4. Update `receive()` method to handle timeline messages
5. Route battle messages with timeline context

### Phase 3: Client Integration  
1. Update Pokémon Showdown client to parse `|timeline|` messages
2. Implement timeline selector component
3. Display timeline tree similar to multi-battle-ui.html
4. Allow switching active timeline view

### Phase 4: Advanced Features
1. Implement "the present" rule
2. Test 4-player support
3. Implement replay logging with timeline metadata

## Test Cases

### High Priority
- [ ] Transferring with only 2 pokemon (should fail on last)
- [ ] Transferring both actives to different turns (no duplication)
- [ ] Transfer before opponent chooses (should queue correctly)
- [ ] Switch timeline mid-battle (UI function)

### Medium Priority
- [ ] 4-player timeline battles
- [ ] Replay saving with timeline data
- [ ] Timer behavior across timelines

### Low Priority
- [ ] Spectator mode across timelines
- [ ] Team validation in timeline formats

## Known Issues & TODOs

### Code Comments in MultiBattleManager.js
```javascript
// TODO: Prevent last pokemon from being transferred ✅
// TODO: Fix weird bug where transfer can delete pokemon ✅
// TODO: Set rule to have "the present" = lowest turn count timelines
// TODO: Verify winning rule: opponent pokemonLeft <= 0
// TODO: Transfer queueing (already working - just needs testing)
// TODO: 4-player support
```

## References

- [Pokemon Showdown Battle Stream](../sim/battle-stream.ts)
- [Room Battle System](../server/room-battle.ts)
- [Format System](../sim/dex-formats.ts)
- [Multi-Battle UI Example](../multi-battle-ui-multiplayer.html)
