# Timeline UI Implementation Guide

## Overview

This document describes the new Timeline UI system that has been integrated into the Pokemon Showdown room battles. The UI visualizes branching timelines, allowing players and spectators to see the timeline structure and navigate between different branches.

## Architecture

### Components

1. **TimelineUI Component** (`server/timeline-ui.tsx`)
   - Generates HTML for the timeline visualizer
   - Provides CSS styling
   - Renders timeline nodes in a hierarchical tree structure

2. **RoomBattle Integration** (`server/room-battle.ts`)
   - Imports timeline UI components
   - Handles timeline messages from the game logic
   - Manages timeline state and updates
   - Sends UI HTML to the room

3. **Multi-Timeline Stream** (`sim/multi-battle-stream.ts`)
   - Already emits `|timeline|` and `|timenodes|` messages
   - Routes commands to correct timeline

## How It Works

### Message Flow

```
1. Battle starts with timeline format
   ↓
2. MultiTimeBattleStream creates Match and Timeline
   ↓
3. Emits |timeline|GLOBALID message
   ↓
4. RoomBattle.receive() catches timeline message
   ↓
5. Emits |timenodes|JSON with timeline structure
   ↓
6. RoomBattle.handleTimenodesMessage() processes it
   ↓
7. Calls sendTimelineUI() to render visualizer
   ↓
8. Timeline UI sent to room via |uhtml| message
   ↓
9. Players see timeline branches in the battle room
```

### Data Structure

The timeline nodes have the following structure:

```typescript
interface TimelineNode {
  id: string;              // Global timeline ID (e.g., "battle-123:1")
  num: number;             // Timeline number within the match (1, 2, 3...)
  turn: number;            // Current turn in this timeline
  parent: string | null;   // Parent timeline ID if branched, null if root
  branchTurn: number | null; // Turn where this timeline branched off
  active: boolean;         // Is this the currently active timeline?
  ended: boolean;          // Has this timeline finished?
}
```

## Usage

### For Developers

#### Enabling Timeline UI for a Format

1. Set the format's `timeline` property to `true`:

```typescript
// In data/formats-data.ts or your format definition
const MyTimelineFormat = {
  name: "My Timeline Format",
  timeline: true,  // Enable timeline features
  // ... other format properties
};
```

2. The timeline UI will automatically appear once battles start using that format.

#### Accessing Timeline Information

In `RoomBattle`, you can access timeline data:

```typescript
// Current active timeline ID
this.currentTimelineId  // e.g., "battle-abc:1"

// All timeline nodes
this.timelineNodes      // Map<string, TimelineNode>

// Update the UI when timelines change
this.updateTimelineUI();
```

### For Players/Spectators

#### What You'll See

1. **Timeline Header** - Shows total number of timelines
2. **Timeline Nodes** - Cards for each timeline showing:
   - Timeline number
   - Current turn
   - Branch point (if branched)
   - Status indicator (current/ended)
3. **Hierarchy** - Indentation shows which timeline is the parent

#### Interacting with the UI

- **Current Timeline** - Highlighted in blue
- **Hover** - Shows timeline details in tooltip
- **Switch Button** - Click to switch to different timeline (when implemented on client-side)

## File Overview

### server/timeline-ui.tsx

**Functions:**

```typescript
// Generate HTML string for the visualizer
generateTimelineHTML(nodes: TimelineNode[]): string

// Get CSS styles
getTimelineStyles(): string
```

**Usage:**

```typescript
import { generateTimelineHTML, getTimelineStyles, type TimelineNode } from './timeline-ui';

const nodes: TimelineNode[] = [
  { id: "battle-1:1", num: 1, turn: 5, parent: null, branchTurn: null, active: true, ended: false },
  { id: "battle-1:2", num: 2, turn: 3, parent: "battle-1:1", branchTurn: 5, active: false, ended: true }
];

const html = generateTimelineHTML(nodes);
const styles = getTimelineStyles();
```

### server/room-battle.ts

**New Properties:**

```typescript
// Timeline tracking
timelineNodes: Map<string, TimelineNode>;
currentTimelineId: string;
timelineUISent: boolean;
```

**New Methods:**

```typescript
// Handle |timeline| messages
private handleTimelineMessage(line: string): void

// Handle |timenodes| messages
private handleTimenodesMessage(line: string): void

// Send the UI to the room
private sendTimelineUI(): void

// Update the UI when nodes change
updateTimelineUI(): void
```

## CSS Classes Reference

### Container Classes

- `.timeline-visualizer` - Main container
- `.timeline-visualizer.empty` - When no timelines available
- `.timeline-header` - Header section with title and count
- `.timeline-branch` - Branch in the tree
- `.timeline-group` - Group of related timelines

### Node Classes

- `.timeline-node` - Individual timeline node
- `.timeline-node.active` - Currently active timeline (blue highlight)
- `.timeline-node.ended` - Ended timeline (faded appearance)

### Element Classes

- `.timeline-title` - Node title section
- `.timeline-turn` - Current turn indicator
- `.branch-indicator` - Arrow showing branch
- `.branch-point` - Branching information
- `.timeline-switch-btn` - Switch button

## Custom Styling

You can override the default styles by adding CSS after the timeline styles load:

```css
/* Make timeline nodes larger */
.timeline-node {
  padding: 15px 16px;
  font-size: 14px;
}

/* Change active timeline color */
.timeline-node.active {
  border-color: #ff6b6b;
  background: #ffe0e0;
}

/* Customize button styles */
.timeline-switch-btn {
  background: #4a90e2;
  color: white;
}
```

## Example: Timeline Battle Format

```typescript
// In your format definition file
export const MyTimelineBattle = {
  name: "Timeline Battle",
  desc: "A battle with timeline branching",
  
  timeline: true,  // Enable timeline features
  
  // Standard format properties
  mod: "gen9",
  banlist: "Obtainable",
  restricted: ["Arceus", "Dialga", "Palkia"],
  
  // ... other properties
};
```

## Integration Points

### Server Messages

The system uses these protocol messages:

| Message | Format | Example |
|---------|--------|---------|
| `\|timeline\|` | `\|timeline\|GLOBALID` | `\|timeline\|battle-123:1` |
| `\|timenodes\|` | `\|timenodes\|JSON` | `\|timenodes\|{...}` |
| `\|uhtml\|` | `\|uhtml\|ID\|HTML` | Sends timeline UI |
| `\|uhtmlchange\|` | `\|uhtmlchange\|ID\|HTML` | Updates timeline UI |

### Client-Side Integration

When the pokemon-showdown-client is updated, it should:

1. **Parse timeline messages:**
   ```javascript
   if (msgParts[0] === 'timeline') {
     const timelineId = msgParts[1];
     updateCurrentTimeline(timelineId);
   }
   ```

2. **Handle transfers (future):**
   ```javascript
   if (msgParts[0] === 'transfer') {
     const source = msgParts[1];
     const target = msgParts[2];
     // Handle Pokémon transfer between timelines
   }
   ```

## Testing Checklist

- [ ] Create a battle using a timeline-enabled format
- [ ] Verify timeline UI appears in the battle room
- [ ] Check that timeline count is correct
- [ ] Verify active timeline is highlighted
- [ ] Confirm CSS styles are applied
- [ ] Test on mobile (CSS media queries should work)
- [ ] Create multiple timelines and verify hierarchy
- [ ] Check that timeline updates when new branches form

## Troubleshooting

### Timeline UI not appearing

1. Check that the format has `timeline: true`
2. Verify that MultiTimeBattleStream is being used
3. Check browser console for errors
4. Verify `timelineUISent` is false initially

### Timeline nodes not updating

1. Check that `handleTimenodesMessage` is receiving messages
2. Verify JSON parsing in the handler
3. Check that `updateTimelineUI()` is called

### Styling issues

1. Verify CSS is being sent via `getTimelineStyles()`
2. Check for CSS conflicts with other styles
3. Clear browser cache
4. Check CSS media queries for responsive design

## Future Enhancements

Planned improvements for the timeline UI:

1. **Client-side rendering** - Move visualization to pokemon-showdown-client
2. **Interactive timeline switching** - Click to switch active timeline
3. **Transfer UI** - Interface for Pokémon transfers between timelines
4. **Timeline animations** - Smooth transitions when branching
5. **Search/filter** - Find specific timelines by turn or criteria
6. **Export/save** - Save timeline structure to file
7. **Replay integration** - Show timelines in replays
8. **Statistics** - Display timeline metrics (branches per turn, etc.)

## Related Files

- [game-logic/MultiBattleManager.js](./game-logic/MultiBattleManager.js) - Timeline management
- [sim/multi-battle-stream.ts](./sim/multi-battle-stream.ts) - Timeline message emission
- [TIMELINE_VISUALIZER_STATUS.md](./TIMELINE_VISUALIZER_STATUS.md) - Overall status
- [TIMELINE_CLIENT_IMPLEMENTATION.md](./TIMELINE_CLIENT_IMPLEMENTATION.md) - Client-side guide

## Support

For questions or issues with the timeline UI implementation:

1. Check this documentation
2. Review the related files listed above
3. Check the TypeScript types in timeline-ui.tsx
4. Review room-battle.ts for integration details

---

**Version:** 1.0  
**Last Updated:** February 2025  
**Status:** Server-side implementation complete, client-side in progress
