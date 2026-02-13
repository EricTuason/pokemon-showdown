/**
 * ROOM-BATTLE.TS INTEGRATION EXAMPLES
 * 
 * This file contains exact code examples for integrating timeline support
 * into server/room-battle.ts. Copy and adapt these sections.
 */

// ============================================================
// SECTION 1: IMPORTS (add to top of file, ~line 16)
// ============================================================

import { MultiTimeBattleStream } from "../sim/multi-battle-stream";
import { MultiBattleManager } from "../game-logic";

// ============================================================
// SECTION 2: ROOM BATTLE CLASS EXTENSION (add properties)
// ============================================================

export class RoomBattle extends RoomGame<RoomBattlePlayer> {
	// ... existing properties ...
	
	// ADD THESE NEW PROPERTIES:
	
	/**
	 * If true, this battle uses timeline branching instead of single timeline
	 */
	isTimelineBattle: boolean = false;
	
	/**
	 * Timeline manager instance (only exists if isTimelineBattle is true)
	 */
	timelineManager?: MultiBattleManager;
	
	/**
	 * Current active timeline ID for the battle
	 */
	activeTimelineId?: string;
	
	/**
	 * Map of player userid -> current timeline they're viewing
	 */
	playerTimelineMap: Map<ID, string> = new Map();
}

// ============================================================
// SECTION 3: CONSTRUCTOR MODIFICATION (at ~line 560)
// ============================================================

// LOCATE THIS CODE:
/*
	constructor(room: GameRoom, options: RoomBattleOptions) {
		super(room);
		// ... setup code ...
		
		this.playerCap = format.playerCount;

		this.stream = PM.createStream();  // <-- THIS LINE
		
		let ratedMessage = options.ratedMessage || '';
*/

// REPLACE IT WITH:
/*
	constructor(room: GameRoom, options: RoomBattleOptions) {
		super(room);
		// ... setup code ...
		
		this.playerCap = format.playerCount;

		// TIMELINE MODE DETECTION AND STREAM CREATION
		this.isTimelineBattle = !!format.timeline;
		if (this.isTimelineBattle) {
			// Create a new MultiBattleManager for this timeline battle
			this.timelineManager = new MultiBattleManager();
			this.stream = new MultiTimeBattleStream(this.timelineManager, {
				replay: this.room.tour ? 'spectator' : false,
			});
		} else {
			// Regular single-timeline battle
			this.stream = PM.createStream();
		}

		let ratedMessage = options.ratedMessage || '';
*/

// ============================================================
// SECTION 4: CHOOSE METHOD MODIFICATION (at ~line 620)
// ============================================================

// LOCATE THIS CODE:
/*
	override choose(user: User, data: string) {
		if (this.frozen) {
			user.popup(`Your battle is currently paused, so you cannot move right now.`);
			return;
		}
		const player = this.playerTable[user.id];
		const [choice, rqid] = data.split('|', 2);  // <-- THIS LINE
		if (!player) return;
		const request = player.request;
		if (request.isWait !== false && request.isWait !== true) {
			player.sendRoom(`|error|[Invalid choice] There's nothing to choose`);
			return;
		}
		const allPlayersWait = this.players.every(p => !!p.request.isWait);
		if (allPlayersWait || // too late
			(rqid && rqid !== `${request.rqid}`)) { // WAY too late
			player.sendRoom(`|error|[Invalid choice] Sorry, too late to make a different move; the next turn has already started`);
			return;
		}
		request.isWait = true;
		request.choice = choice;

		void this.stream.write(`>${player.slot} ${choice}`);  // <-- THIS LINE
	}
*/

// REPLACE WITH:
/*
	override choose(user: User, data: string) {
		if (this.frozen) {
			user.popup(`Your battle is currently paused, so you cannot move right now.`);
			return;
		}
		const player = this.playerTable[user.id];
		
		// TIMELINE SUPPORT: Parse optional timeline ID from choice
		const [choice, rqid, maybeTimelineId] = data.split('|', 3);  // 3 instead of 2
		
		if (!player) return;
		const request = player.request;
		if (request.isWait !== false && request.isWait !== true) {
			player.sendRoom(`|error|[Invalid choice] There's nothing to choose`);
			return;
		}
		const allPlayersWait = this.players.every(p => !!p.request.isWait);
		if (allPlayersWait || // too late
			(rqid && rqid !== `${request.rqid}`)) { // WAY too late
			player.sendRoom(`|error|[Invalid choice] Sorry, too late to make a different move; the next turn has already started`);
			return;
		}
		request.isWait = true;
		request.choice = choice;

		// TIMELINE SUPPORT: Track which timeline player is in
		if (this.isTimelineBattle && maybeTimelineId) {
			this.playerTimelineMap.set(user.id, maybeTimelineId);
		}

		// Write to stream with optional timeline ID
		if (this.isTimelineBattle && maybeTimelineId) {
			void this.stream.write(`>${player.slot} ${choice}|${maybeTimelineId}`);
		} else {
			void this.stream.write(`>${player.slot} ${choice}`);
		}
	}
*/

// ============================================================
// SECTION 5: RECEIVE METHOD MODIFICATION (at ~line 820)
// ============================================================

// LOCATE THIS CODE:
/*
	receive(lines: string[]) {
		for (const player of this.players) player.wantsTie = false;

		switch (lines[0]) {
		case 'requesteddata':
			// ...
			break;

		case 'update':
			for (const line of lines.slice(1)) {
				if (line.startsWith('|turn|')) {
					this.turn = parseInt(line.slice(6));
				}
				this.room.add(line);  // <-- ADD CHECKS BEFORE THIS
*/

// REPLACE WITH:
/*
		case 'update':
			for (const line of lines.slice(1)) {
				// TIMELINE SUPPORT: Parse timeline context
				if (line.startsWith('|timeline|')) {
					// Extract timeline ID and store it
					this.activeTimelineId = line.slice(10).trim();
					// Still pass through to clients
					this.room.add(line);
					continue;
				}
				
				// TIMELINE SUPPORT: Pass timeline node info to clients
				if (line.startsWith('|timenodes|')) {
					// This contains the timeline tree structure
					this.room.add(line);
					continue;
				}
				
				if (line.startsWith('|turn|')) {
					this.turn = parseInt(line.slice(6));
				}
				this.room.add(line);
*/

// ============================================================
// SECTION 6: ADD HELPER METHOD (add after receive method)
// ============================================================

// ADD THIS NEW METHOD TO RoomBattle CLASS:

	/**
	 * Get the current timeline ID for the battle
	 * Returns the active timeline, or empty string if not a timeline battle
	 */
	getActiveTimeline(): string {
		if (!this.isTimelineBattle) return '';
		return this.activeTimelineId || '';
	}

	/**
	 * Get available transfer targets for a player
	 * Used by UI to show where a player can transfer their pokemon
	 */
	getTransferTargets(side: 'p1' | 'p2'): any[] {
		if (!this.isTimelineBattle || !this.timelineManager) return [];
		return this.timelineManager.getTransferTargets(undefined);
	}

// ============================================================
// SECTION 7: OPTIONAL - ADD TO SETPLAYER METHOD
// ============================================================

// If you want to track which player is in which timeline:
/*
	setPlayerUser(player: RoomBattlePlayer, user: User, options?: { team?: string }) {
		// ... existing code ...
		
		// OPTIONAL: Track that this player just entered
		if (this.isTimelineBattle && this.activeTimelineId) {
			this.playerTimelineMap.set(user.id, this.activeTimelineId);
		}
	}
*/

// ============================================================
// SECTION 8: TEST CONFIGURATION
// ============================================================

// Add to your config/formats.ts to test:

/*
	{
		name: "[Gen 9] OU Timeline",
		desc: `OU but with timeline branching. Transfer Pokémon to past turns!`,
		mod: 'gen9',
		timeline: true,  // <-- THIS ENABLES TIMELINE MODE
		ruleset: ['Standard', 'Evasion Abilities Clause', 'Sleep Moves Clause', '!Sleep Clause Mod'],
		banlist: ['Uber', 'AG', 'Arena Trap', 'Moody', 'Shadow Tag', "King's Rock", 'Razor Fang', 'Baton Pass', 'Last Respects', 'Shed Tail'],
	},
*/

// ============================================================
// NOTES
// ============================================================

/*
1. The MultiTimeBattleStream is a drop-in replacement for BattleStream
2. It automatically routes all battle commands to the MultiBattleManager
3. Make sure imports are at the top of the file
4. All protocol messages that include timeline info will be passed through
5. The client will receive |timeline| and |timenodes| messages
6. PlayerTimelineMap is optional - use it if you need to track per-player views
7. The isTimelineBattle flag controls which code path is taken throughout RoomBattle

TYPE SAFETY NOTES:
- Make sure MultiBattleManager is properly imported with correct type
- activeTimelineId will be undefined until first |timeline| message
- Check isTimelineBattle before accessing timelineManager
- All optional chaining is recommended (timelineManager?.getTransferTargets())
*/
