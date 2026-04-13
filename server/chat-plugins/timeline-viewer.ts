/**
 * Timeline Viewer Page
 *
 * Registers `/view-timeline-<roomid>`, a read-only page that re-renders
 * the most recent `|timenodes|` snapshot of a running timeline battle.
 *
 * Linked to from the "pop out" bar RoomBattle adds under its in-chat
 * `|uhtml|timeline-viz|…` message.
 *
 * Why it's read-only:
 *   Showdown's chat/page sanitizer strips <script>, so the interactive
 *   controls from the standalone timeline-viewer HTML file can't live
 *   here. For that workflow users copy the raw JSON (exposed in the
 *   in-chat <details> pane) and paste it into the standalone viewer.
 */

import { Utils } from '../../lib';
import { generateTimelineHTML } from '../timeline-ui';
import type { RoomBattle } from '../room-battle';

export const pages: Chat.PageTable = {
	timeline(query, user) {
		// `query` is the URL tail after `view-timeline-`, split on `-`.
		// Battle IDs are `battle-<format>-<num>`, so the split gives
		// e.g. ['battle','gen9ou','12345']; rejoin to recover the id.
		const roomid = query.join('-') as RoomID;
		this.title = `[Timeline] ${roomid || '?'}`;

		if (!roomid) {
			return (
				'<div class="pad"><h2>Timeline Viewer</h2>' +
				'<p>Usage: <code>/view-timeline-&lt;battle-room-id&gt;</code></p></div>'
			);
		}

		const room = Rooms.get(roomid);
		if (!room) {
			return (
				'<div class="pad"><h2>Room not found</h2>' +
				`<p>No room with ID <code>${Utils.escapeHTML(roomid)}</code>.</p></div>`
			);
		}
		if (!room.battle) {
			return '<div class="pad"><h2>Not a battle room</h2></div>';
		}

		const battle = room.battle as RoomBattle;

		// Privacy: a strictly-private battle (`isPrivate === true`) is
		// only visible to its players and global staff. Hidden / public
		// battles are visible to anyone with the link, matching normal
		// battle-link sharing semantics.
		if (
			room.settings.isPrivate === true &&
			!(user.id in battle.playerTable)
		) {
			this.checkCan('lock');
		}

		const data = battle.lastTimelineData;
		if (!data) {
			return (
				'<div class="pad"><h2>Timeline not yet available</h2>' +
				'<p>Play at least one turn in the battle, then refresh.</p>' +
				`<button class="button" name="send" value="/join view-timeline-${roomid}">` +
				'Refresh</button></div>'
			);
		}

		const refreshBtn =
			`<button class="button" name="send" value="/join view-timeline-${roomid}">` +
			'\u21BB Refresh</button>';

		return (
			'<div class="pad" style="font-family:Arial,Helvetica,sans-serif;">' +
			'<div style="display:flex;justify-content:space-between;align-items:center;' +
			'margin-bottom:10px;gap:8px;flex-wrap:wrap;">' +
			`<h2 style="margin:0;font-size:16px;">Timeline \u2014 ${Utils.escapeHTML(roomid)}</h2>` +
			refreshBtn +
			'</div>' +
			generateTimelineHTML(data) +
			'</div>'
		);
	},
};