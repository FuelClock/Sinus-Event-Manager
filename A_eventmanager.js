// Event Manager Plugin v1.0.0 for SinusBot
// Event templates with {date}/{time} placeholders, multi-stage scheduling,
// and an always-updated board channel listing upcoming events (soonest first).
// Follows the same pattern as A_rostermanager.js with OKlib integration and a
// tested fallback path.

registerPlugin({
    name: 'Event Manager',
    version: '1.0.0',
    author: 'FuelClock',
    description: 'Reusable event templates, multi-stage event scheduling and an auto-updating events board',
    backends: ['ts3'],
    vars: [
        { name: 'BOT_NAME', title: 'Event Command Name (used as !<name>)', type: 'string', default: 'event' },
        { name: 'LIST_NAME', title: 'Event Listing Command Name', type: 'string', default: 'events' },
        { name: 'CREATOR_GROUP', title: 'Server Group ID (may create templates/events)', type: 'string', default: '3' },
        { name: 'ADMIN_GROUP', title: 'Server Group ID (may remove any event/template)', type: 'string', default: '17' },
        { name: 'EVENT_CHANNEL_ID', title: 'Board channel (event list in description)', type: 'channel' },
        { name: 'MINI_BOARD_CHANNEL_ID', title: 'Minimal board channel (event/date/host only)', type: 'channel' },
        { name: 'MINI_BOARD_TITLE', title: 'Minimal board title in the description', type: 'string', default: 'Events' },
        { name: 'TEMPLATE_PARENT_CHANNEL_ID', title: 'Parent for temporary template channels (blank = board channel)', type: 'channel' },
        { name: 'STICKY_CHANNEL_ID', title: 'Channel the bot returns to (blank = stay)', type: 'channel' },
        { name: 'CHANNEL_ADMIN_GROUP', title: 'Channel Group ID granted in template channels', type: 'string', default: '8' },
        { name: 'BOARD_TITLE', title: 'Board title in the channel description', type: 'string', default: 'Upcoming Events' },
        { name: 'MAX_BOARD_EVENTS', title: 'Max events shown on the board', type: 'number', default: '20' },
        { name: 'AUTO_CLEAR_HOURS', title: 'Hours after start before an event is removed', type: 'number', default: '6' },
        { name: 'TIMEZONE', title: 'Timezone the dates are read in', type: 'string', default: 'Europe/Amsterdam' },
        { name: 'SESSION_TIMEOUT_MINUTES', title: 'Minutes before an unfinished command expires', type: 'number', default: '15' }
    ],
    requiredModules: ['engine', 'backend', 'event', 'store'],
    autorun: false
}, function(_, config, meta) {
    const engine = require('engine');
    const backend = require('backend');
    const event = require('event');

    var botName = String(config.BOT_NAME || 'event');
    var listName = String(config.LIST_NAME || 'events');
    var creatorGroupId = String(config.CREATOR_GROUP || '3');
    var adminGroupId = String(config.ADMIN_GROUP || '17');
    var eventChannelId = configuredId(config.EVENT_CHANNEL_ID);
    var miniBoardChannelId = configuredId(config.MINI_BOARD_CHANNEL_ID);
    var miniBoardTitle = String(config.MINI_BOARD_TITLE || 'Events');
    var templateParentChannelId = configuredId(config.TEMPLATE_PARENT_CHANNEL_ID);
    var stickyChannelId = configuredId(config.STICKY_CHANNEL_ID);
    var channelAdminGroupId = String(config.CHANNEL_ADMIN_GROUP || '');
    var boardTitle = String(config.BOARD_TITLE || 'Upcoming Events');
    var maxBoardEvents = Math.max(1, parseInt(config.MAX_BOARD_EVENTS, 10) || 20);
    var autoClearHours = Math.max(0.1, parseFloat(config.AUTO_CLEAR_HOURS) || 6);
    var sessionTimeoutMs = Math.max(1, parseInt(config.SESSION_TIMEOUT_MINUTES, 10) || 15) * 60 * 1000;

    function configuredId(value) {
        if (!value) return '';
        if (typeof value === 'object' && typeof value.id === 'function') return String(value.id());
        if (typeof value === 'object' && value.id !== undefined) return String(value.id);
        return String(value);
    }

    // ===== PERSISTENCE =====
    var templates = [];  // {id, name, ownerUid, ownerName, text, createdAt}
    var events = [];     // {id, templateId, templateName, text, startMs, ownerUid, ownerName, createdAt}
    var sessions = {};   // uid -> session object (survives a bot restart)
    var orphanChannels = {}; // channelId -> orphaned template channel awaiting deletion
    var nextTemplateId = 1;
    var nextEventId = 1;
    var persistenceInitialized = false;
    var store = null;

    // ===== STORE MODULE =====
    try {
        store = require('store');
    } catch (e) {
        engine.log('[EventManager] FATAL: Store module unavailable — persistence disabled.');
        store = null;
    }

    // ===== OKLIB INTEGRATION =====
    var oklib = null;
    var oklibAvailable = false;

    try {
        var loadedOklib = require('OKlib.js');
        if (loadedOklib && loadedOklib.general &&
            typeof loadedOklib.general.checkVersion === 'function' &&
            loadedOklib.general.checkVersion('1.0.6')) {
            oklib = loadedOklib;
            oklibAvailable = true;
        }
    } catch (e) {
        engine.log('[EventManager] WARNING: OKlib could not be loaded: ' + e.message);
    }

    function logMessage(message, level) {
        if (oklibAvailable && oklib.general && typeof oklib.general.log === 'function') {
            oklib.general.log('[EventManager] ' + message, level || 4);
            return;
        }
        engine.log('[EventManager] ' + message);
    }

    function containsIgnoreCase(value, search) {
        if (oklibAvailable && oklib.comparator && typeof oklib.comparator.containsIgnoreCase === 'function') {
            return oklib.comparator.containsIgnoreCase(String(value || ''), String(search || ''));
        }
        return String(value || '').toLowerCase().indexOf(String(search || '').toLowerCase()) !== -1;
    }

    function equalsIgnoreCase(left, right) {
        return containsIgnoreCase(left, right) && containsIgnoreCase(right, left);
    }

    function isMemberOfOne(client, groups) {
        if (oklibAvailable && oklib.client && typeof oklib.client.isMemberOfOne === 'function') {
            return oklib.client.isMemberOfOne(client, groups);
        }
        if (!client || typeof client.getServerGroups !== 'function') {
            return false;
        }
        var groupIds = Array.isArray(groups) ? groups : [groups];
        var clientGroups = client.getServerGroups();
        for (var i = 0; i < clientGroups.length; i++) {
            var clientId = String(clientGroups[i].id());
            for (var j = 0; j < groupIds.length; j++) {
                if (clientId === String(groupIds[j])) {
                    return true;
                }
            }
        }
        return false;
    }

    function isAdmin(client) {
        return isMemberOfOne(client, [adminGroupId]);
    }

    function mayManageEvents(client) {
        return isMemberOfOne(client, [creatorGroupId]) || isAdmin(client);
    }

    function clientKey(client) {
        if (!client) return '';
        if (typeof client.uid === 'function' && client.uid()) return String(client.uid());
        return 'name:' + String(client.name ? client.name() : '');
    }

    // ===== TIMEZONE (Europe/Amsterdam: UTC+1, UTC+2 in summer time) =====
    // The runtime cannot be relied on to resolve IANA zones, so the EU DST rule
    // is implemented directly: summer time runs from the last Sunday of March
    // 01:00 UTC to the last Sunday of October 01:00 UTC.
    function lastSundayUtcMs(year, monthIndex, hourUtc) {
        var lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
        for (var day = lastDay; day >= 1; day--) {
            var probe = new Date(Date.UTC(year, monthIndex, day));
            if (probe.getUTCDay() === 0) {
                return Date.UTC(year, monthIndex, day, hourUtc);
            }
        }
        return Date.UTC(year, monthIndex, lastDay, hourUtc);
    }

    function isSummerTime(year, month, day, hour, minute) {
        var stamp = Date.UTC(year, month - 1, day, hour, minute);
        var dstStart = lastSundayUtcMs(year, 2, 1);
        var dstEnd = lastSundayUtcMs(year, 9, 1);
        return stamp >= dstStart && stamp < dstEnd;
    }

    function localToEpochMs(year, month, day, hour, minute) {
        var wall = Date.UTC(year, month - 1, day, hour, minute);
        var offsetHours = isSummerTime(year, month, day, hour, minute) ? 2 : 1;
        return wall - offsetHours * 60 * 60 * 1000;
    }

    function pad2(value) {
        var text = String(value);
        return text.length >= 2 ? text : '0' + text;
    }

    function formatEpochMs(epochMs) {
        var d = new Date(epochMs);
        return pad2(d.getUTCDate()) + '/' + pad2(d.getUTCMonth() + 1) + '/' + d.getUTCFullYear() +
            ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
    }

    // The bot computes in UTC+1/+2 wall-clock time, so formatting from UTC
    // components requires shifting into that offset first.
    function partsFromEpochMs(epochMs) {
        var shifted = new Date(epochMs + amsterdamOffsetMs(epochMs));
        return {
            day: shifted.getUTCDate(),
            month: shifted.getUTCMonth() + 1,
            year: shifted.getUTCFullYear(),
            hour: shifted.getUTCHours(),
            minute: shifted.getUTCMinutes(),
            weekday: shifted.getUTCDay()
        };
    }

    function amsterdamOffsetMs(epochMs) {
        var year = new Date(epochMs).getUTCFullYear();
        var dstStart = lastSundayUtcMs(year, 2, 1);
        var dstEnd = lastSundayUtcMs(year, 9, 1);
        var inside = (epochMs >= dstStart && epochMs < dstEnd);
        return (inside ? 2 : 1) * 60 * 60 * 1000;
    }

    var WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    function formatBoardStamp(epochMs) {
        var p = partsFromEpochMs(epochMs);
        return WEEKDAYS[p.weekday] + ' ' + p.day + ' ' + MONTHS[p.month - 1] + ' ' + p.year +
            ', ' + pad2(p.hour) + ':' + pad2(p.minute);
    }

    function formatDatePlaceholder(epochMs) {
        var p = partsFromEpochMs(epochMs);
        return pad2(p.day) + '/' + pad2(p.month) + '/' + p.year;
    }

    function formatTimePlaceholder(epochMs) {
        var p = partsFromEpochMs(epochMs);
        return pad2(p.hour) + ':' + pad2(p.minute);
    }

    function epochFromWallClock(year, month, day, hour, minute) {
        return localToEpochMs(year, month, day, hour, minute);
    }

    // ===== INPUT PARSING =====
    // Date: DD/MM/YYYY (also tolerates D/M/YYYY and DD.MM.YYYY).
    function parseDateInput(text) {
        var match = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/.exec(String(text || '').trim());
        if (!match) return null;
        var day = parseInt(match[1], 10);
        var month = parseInt(match[2], 10);
        var year = parseInt(match[3], 10);
        if (month < 1 || month > 12 || day < 1 || day > 31) return null;
        var daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
        if (day > daysInMonth) return null;
        return { day: day, month: month, year: year };
    }

    // Time: HH:MM 24h (also tolerates HH.MM and HHMM).
    function parseTimeInput(text) {
        var match = /^(\d{1,2})[:.]?(\d{2})$/.exec(String(text || '').trim());
        if (!match) return null;
        var hour = parseInt(match[1], 10);
        var minute = parseInt(match[2], 10);
        if (hour > 23 || minute > 59) return null;
        return { hour: hour, minute: minute };
    }

    // ===== TEMPLATE RENDERING =====
    function renderTemplate(text, startMs) {
        return String(text || '')
            .replace(/\{date\}/gi, formatDatePlaceholder(startMs))
            .replace(/\{time\}/gi, formatTimePlaceholder(startMs));
    }

    // ===== EVENTS =====
    function upcomingEvents(nowMs) {
        var now = nowMs || Date.now();
        var out = [];
        for (var i = 0; i < events.length; i++) {
            if (events[i].startMs > now - autoClearHours * 60 * 60 * 1000) {
                out.push(events[i]);
            }
        }
        out.sort(function(a, b) {
            if (a.startMs !== b.startMs) return a.startMs - b.startMs;
            return a.id - b.id;
        });
        return out;
    }

    function dropExpiredEvents() {
        var now = Date.now();
        var kept = [];
        var dropped = [];
        for (var i = 0; i < events.length; i++) {
            if (events[i].startMs <= now - autoClearHours * 60 * 60 * 1000) {
                dropped.push(events[i]);
            } else {
                kept.push(events[i]);
            }
        }
        if (!dropped.length) return 0;
        events = kept;
        if (persistenceInitialized) saveData();
        logMessage('Removed ' + dropped.length + ' expired event(s) (more than ' +
            autoClearHours + 'h after start).', 3);
        return dropped.length;
    }

    // ===== BOARD =====
    function renderBoard() {
        var now = Date.now();
        var list = upcomingEvents(now);
        var board = '';
        if (!list.length) {
            board = '[center]No upcoming events.[/center]';
        } else {
            var shown = list.slice(0, maxBoardEvents);
            for (var i = 0; i < shown.length; i++) {
                var ev = shown[i];
                board += '[b]' + (i + 1) + '. ' + ev.templateName + '[/b] — ' + formatBoardStamp(ev.startMs) +
                    '  (by ' + ev.ownerName + ')\n' + ev.text + '\n\n';
            }
            if (list.length > shown.length) {
                board += '... and ' + (list.length - shown.length) + ' more event(s). Use !' +
                    listName + ' in chat for the full list.';
            }
        }
        var header = '[center][b][color=#FFD700]' + boardTitle + '[/color][/b][/center]\n' +
            '[center]Scheduled with !' + botName + '[/center]';
        return header + '\n\n' + board;
    }

    function writeDescription(channelId, description, label) {
        var channel = backend.getChannelByID(channelId);
        if (!channel) {
            logMessage(label + ' channel ' + channelId + ' not found.', 2);
            return;
        }
        if (description.length > 6000) {
            // Degrade instead of risking a server-side rejection of the whole write.
            description = description.substring(0, 5900) +
                '\n[center]Board truncated — shorten templates or lower MAX_BOARD_EVENTS.[/center]';
        }
        try {
            channel.setDescription(description);
        } catch (e) {
            logMessage('ERROR updating ' + label + ' description: ' + e.message, 1);
        }
    }

    function updateBoard() {
        if (eventChannelId) {
            writeDescription(eventChannelId, renderBoard(), 'board');
        }
        if (miniBoardChannelId) {
            writeDescription(miniBoardChannelId, renderMiniBoard(), 'minimal board');
        }
    }

    // Minimal board: title, date and host only, no template body.
    function renderMiniBoard() {
        var list = upcomingEvents(Date.now());
        var lines = '';
        if (!list.length) {
            lines = '[center]No upcoming events.[/center]';
        } else {
            var shown = list.slice(0, maxBoardEvents);
            for (var i = 0; i < shown.length; i++) {
                var ev = shown[i];
                lines += '[b]Event:[/b] ' + ev.templateName + '\n' +
                    '[b]Date:[/b] ' + formatTimePlaceholder(ev.startMs) + ' ' + formatDatePlaceholder(ev.startMs) + '\n' +
                    '[b]Host:[/b] ' + ev.ownerName + '\n\n';
            }
            if (list.length > shown.length) {
                lines += '... and ' + (list.length - shown.length) + ' more event(s).';
            }
        }
        return '[center][b][color=#FFD700]' + miniBoardTitle + '[/color][/b][/center]\n\n' + lines;
    }

    // ===== TEMPLATES =====
    function templatesOf(uid) {
        var out = [];
        for (var i = 0; i < templates.length; i++) {
            if (templates[i].ownerUid === uid) out.push(templates[i]);
        }
        out.sort(function(a, b) { return a.id - b.id; });
        return out;
    }

    function findTemplateByName(uid, name) {
        var mine = templatesOf(uid);
        for (var i = 0; i < mine.length; i++) {
            if (equalsIgnoreCase(mine[i].name, name)) return mine[i];
        }
        return null;
    }

    function saveTemplate(uid, ownerName, name, text) {
        var existing = findTemplateByName(uid, name);
        if (existing) {
            existing.text = text;
            existing.updatedAt = new Date().toISOString();
            if (persistenceInitialized) saveData();
            return existing;
        }
        var tpl = {
            id: nextTemplateId++,
            name: name,
            ownerUid: uid,
            ownerName: ownerName,
            text: text,
            createdAt: new Date().toISOString()
        };
        templates.push(tpl);
        if (persistenceInitialized) saveData();
        return tpl;
    }

    // ===== SESSIONS (multi-stage) =====
    function getSession(uid) {
        return sessions[uid] || null;
    }

    function setSession(uid, session) {
        session.updatedAt = Date.now();
        sessions[uid] = session;
        if (persistenceInitialized) saveData();
    }

    function clearSession(uid) {
        if (sessions[uid]) {
            delete sessions[uid];
            if (persistenceInitialized) saveData();
        }
    }

    function cancelTemplateSession(uid, reason) {
        var session = getSession(uid);
        if (!session || session.stage !== 'template_edit') {
            clearSession(uid);
            return;
        }
        deleteTemplateChannel(session);
        clearSession(uid);
        logMessage('Template creation cancelled for ' + session.ownerName + ' (' + reason + ').', 3);
    }

    function cancelSession(uid, reason) {
        var session = getSession(uid);
        if (!session) return;
        if (session.stage === 'template_edit') {
            cancelTemplateSession(uid, reason);
            return;
        }
        clearSession(uid);
        logMessage('Command cancelled for ' + session.ownerName + ' (' + reason + ').', 3);
    }

    // ===== TEMPORARY TEMPLATE CHANNEL =====
    function parentChannelIdForTemplates() {
        return templateParentChannelId || eventChannelId;
    }

    function templateChannelName(name) {
        var text = 'Template: ' + name;
        return text.length > 38 ? text.substring(0, 38) : text;
    }

    function templateChannelDescription(ownerName) {
        return 'Template editor for ' + ownerName + '.\n\n' +
            'Write your event template into THIS description.\n' +
            'Use {date} and {time} where the date and time should go.\n' +
            'Then type "save template" in chat, or "cancel template".';
    }

    function createTemplateChannel(name, ownerName) {
        var parentId = parentChannelIdForTemplates();
        if (!parentId) {
            return null;
        }
        var params = {
            name: templateChannelName(name),
            description: templateChannelDescription(ownerName),
            parent: parentId,
            permanent: false,
            deleteDelay: 300
        };
        var created = null;
        try {
            created = backend.createChannel(params);
        } catch (e) {
            logMessage('ERROR creating template channel: ' + e.message, 1);
            return null;
        }
        return created;
    }

    function clientByUid(uid) {
        var clients = [];
        try {
            clients = backend.getClients();
        } catch (e) {
            return null;
        }
        for (var i = 0; i < clients.length; i++) {
            if (clients[i] && typeof clients[i].uid === 'function' && String(clients[i].uid()) === String(uid)) {
                return clients[i];
            }
        }
        return null;
    }

    // The SinusBot Client object exposes NO channel accessor (verified live against
    // 0.9.x/1.0.2: there is no client.channel(), client.chan() or clientId).
    // Occupancy must therefore come from the channel side: Channel.getClients().
    function occupantsOf(channel) {
        if (!channel || typeof channel.getClients !== 'function') {
            return [];
        }
        try {
            var list = channel.getClients();
            return Array.isArray(list) ? list : [];
        } catch (e) {
            logMessage('WARNING: could not read channel occupants: ' + e.message, 2);
            return [];
        }
    }

    function moveClientOutOf(channel, client, targetId) {
        if (!client || !targetId) return false;
        var occupants = occupantsOf(channel);
        for (var i = 0; i < occupants.length; i++) {
            if (typeof occupants[i].equals === 'function' && occupants[i].equals(client)) {
                try {
                    client.moveTo(targetId);
                    return true;
                } catch (e) {
                    logMessage('WARNING: could not move a client out of the template channel: ' + e.message, 2);
                    return false;
                }
            }
        }
        return false;
    }

    // A channel can only be deleted while it is empty, so both the author and
    // the bot are moved out before the delete is attempted.
    function deleteTemplateChannel(session) {
        if (!session || !session.channelId) return;
        var channel = backend.getChannelByID(session.channelId);
        if (!channel) {
            clearOrphanChannel(session.channelId); // already gone server-side
            return;
        }
        var targetId = stickyChannelId || parentChannelIdForTemplates();

        var author = clientByUid(session.ownerUid);
        moveClientOutOf(channel, author, targetId);

        try {
            moveClientOutOf(channel, backend.getBotClient(), targetId);
        } catch (e) {
            logMessage('WARNING: could not move bot to sticky channel: ' + e.message, 2);
        }

        // Never delete a channel that is still occupied: a failed delete would
        // leave a stray channel behind with the author stranded in it. Record it
        // so the maintenance pass retries once the channel empties, instead of
        // orphaning it with its session already cleared.
        var stillOccupied = occupantsOf(channel);
        if (stillOccupied.length > 0) {
            rememberOrphanChannel(session);
            logMessage('Template channel ' + session.channelId + ' still holds ' +
                stillOccupied.length + ' client(s) — not deleting yet. Will retry when it empties.', 2);
            return;
        }

        try {
            channel.delete();
            clearOrphanChannel(session.channelId);
            logMessage('Deleted template channel ' + session.channelId + '.', 3);
        } catch (e) {
            rememberOrphanChannel(session);
            logMessage('ERROR deleting template channel (' + e.message +
                ') — will retry on the next maintenance pass.', 1);
        }
    }

    // Orphaned template channels outlive the session that created them (the
    // session is cleared on save/cancel), so they are tracked separately.
    function rememberOrphanChannel(session) {
        if (!session || !session.channelId) return;
        orphanChannels[String(session.channelId)] = {
            channelId: String(session.channelId),
            ownerUid: String(session.ownerUid || ''),
            ownerName: String(session.ownerName || ''),
            since: Date.now()
        };
        if (persistenceInitialized) saveData();
    }

    function clearOrphanChannel(channelId) {
        var key = String(channelId);
        if (orphanChannels[key]) {
            delete orphanChannels[key];
            if (persistenceInitialized) saveData();
        }
    }

    // Retried on every maintenance tick; only reports when something changes so
    // a permanently stuck channel does not flood the log once a minute.
    var lastOrphanReport = '';
    function retryOrphanChannels() {
        var targetId = stickyChannelId || parentChannelIdForTemplates();
        var changed = false;
        for (var key in orphanChannels) {
            if (!orphanChannels.hasOwnProperty(key)) continue;
            var entry = orphanChannels[key];
            var channel = backend.getChannelByID(entry.channelId);
            if (!channel) {
                delete orphanChannels[key];
                changed = true;
                continue;
            }
            var occupants = occupantsOf(channel);
            if (!occupants.length) {
                try {
                    channel.delete();
                    logMessage('Cleaned up orphaned template channel ' + entry.channelId + '.', 3);
                    delete orphanChannels[key];
                    changed = true;
                    continue;
                } catch (e) {
                    logMessage('ERROR cleaning up orphaned channel ' + entry.channelId + ': ' + e.message, 1);
                    continue;
                }
            }
            // Try once more to move the owner out, in case they were the blocker.
            moveClientOutOf(channel, clientByUid(entry.ownerUid), targetId);
            if (occupantsOf(channel).length) {
            } else {
                try {
                    channel.delete();
                    logMessage('Cleaned up orphaned template channel ' + entry.channelId + ' after its owner left.', 3);
                    delete orphanChannels[key];
                    changed = true;
                } catch (e) {
                    logMessage('ERROR cleaning up orphaned channel ' + entry.channelId + ': ' + e.message, 1);
                }
            }
        }
        if (persistenceInitialized && changed) {
            saveData();
        }
        var report = 'orphaned template channels: ' + Object.keys(orphanChannels).length;
        if (report !== lastOrphanReport) {
            if (Object.keys(orphanChannels).length > 0) {
                logMessage('Still waiting to delete ' + report, 2);
            }
            lastOrphanReport = report;
        }
    }

    function grantChannelAdmin(client, channelId) {
        if (!channelAdminGroupId) {
            logMessage('WARNING: CHANNEL_ADMIN_GROUP is not set — the author cannot edit the template description.', 2);
            return false;
        }
        var group = backend.getChannelGroupByID(channelAdminGroupId);
        if (!group) {
            logMessage('WARNING: Channel group ' + channelAdminGroupId + ' not found — cannot grant template channel admin.', 2);
            return false;
        }
        var channel = backend.getChannelByID(channelId);
        if (!channel) return false;
        try {
            channel.setChannelGroup(client, group);
            return true;
        } catch (e) {
            logMessage('ERROR granting channel admin group: ' + e.message, 1);
            return false;
        }
    }

    // ===== PERSISTENCE HELPERS =====
    function sanitizeTemplate(entry) {
        if (!entry || typeof entry !== 'object') return null;
        if (typeof entry.name !== 'string' || !entry.name) return null;
        if (typeof entry.text !== 'string' || !entry.text) return null;
        var out = {};
        for (var key in entry) {
            if (entry.hasOwnProperty(key)) out[key] = entry[key];
        }
        out.id = parseInt(entry.id, 10) || 0;
        out.name = entry.name;
        out.text = entry.text;
        out.ownerUid = String(entry.ownerUid || '');
        out.ownerName = String(entry.ownerName || 'unknown');
        return out.id ? out : null;
    }

    function sanitizeEvent(entry) {
        if (!entry || typeof entry !== 'object') return null;
        var startMs = parseInt(entry.startMs, 10);
        if (isNaN(startMs) || !startMs) return null;
        if (typeof entry.text !== 'string' || !entry.text) return null;
        var out = {};
        for (var key in entry) {
            if (entry.hasOwnProperty(key)) out[key] = entry[key];
        }
        out.id = parseInt(entry.id, 10) || 0;
        out.startMs = startMs;
        out.text = entry.text;
        out.templateId = parseInt(entry.templateId, 10) || 0;
        out.templateName = String(entry.templateName || 'Event');
        out.ownerUid = String(entry.ownerUid || '');
        out.ownerName = String(entry.ownerName || 'unknown');
        return out.id ? out : null;
    }

    function sanitizeSession(entry) {
        if (!entry || typeof entry !== 'object') return null;
        if (typeof entry.stage !== 'string' || !entry.stage) return null;
        var out = {};
        for (var key in entry) {
            if (entry.hasOwnProperty(key)) out[key] = entry[key];
        }
        out.stage = entry.stage;
        out.ownerUid = String(entry.ownerUid || '');
        out.ownerName = String(entry.ownerName || 'unknown');
        return out.ownerUid ? out : null;
    }

    function saveData() {
        if (!store) return;
        try {
            store.set('eventTemplates', JSON.stringify(templates));
            store.set('eventEntries', JSON.stringify(events));
            store.set('eventSessions', JSON.stringify(sessions));
            store.set('eventOrphanChannels', JSON.stringify(orphanChannels));
            store.set('eventCounters', JSON.stringify({ template: nextTemplateId, event: nextEventId }));
        } catch (e) {
            logMessage('ERROR saving data: ' + e.message, 1);
        }
    }

    function loadPersistedData() {
        if (!store) {
            logMessage('WARNING: store unavailable — starting with empty data.', 2);
            return;
        }
        try {
            var rawTemplates = store.get('eventTemplates');
            if (rawTemplates) {
                var parsedTemplates = JSON.parse(rawTemplates);
                var loadedTemplates = [];
                if (Array.isArray(parsedTemplates)) {
                    for (var i = 0; i < parsedTemplates.length; i++) {
                        var clean = sanitizeTemplate(parsedTemplates[i]);
                        if (clean) loadedTemplates.push(clean);
                    }
                }
                templates = loadedTemplates;
            }
            var rawEvents = store.get('eventEntries');
            if (rawEvents) {
                var parsedEvents = JSON.parse(rawEvents);
                var loadedEvents = [];
                if (Array.isArray(parsedEvents)) {
                    for (var e = 0; e < parsedEvents.length; e++) {
                        var cleanEvent = sanitizeEvent(parsedEvents[e]);
                        if (cleanEvent) loadedEvents.push(cleanEvent);
                    }
                }
                events = loadedEvents;
            }
            var rawSessions = store.get('eventSessions');
            if (rawSessions) {
                var parsedSessions = JSON.parse(rawSessions);
                var loadedSessions = {};
                if (parsedSessions && typeof parsedSessions === 'object') {
                    for (var uid in parsedSessions) {
                        if (!parsedSessions.hasOwnProperty(uid)) continue;
                        var cleanSession = sanitizeSession(parsedSessions[uid]);
                        if (cleanSession) loadedSessions[uid] = cleanSession;
                    }
                }
                sessions = loadedSessions;
            }
            var rawOrphans = store.get('eventOrphanChannels');
            if (rawOrphans) {
                var parsedOrphans = JSON.parse(rawOrphans);
                var loadedOrphans = {};
                if (parsedOrphans && typeof parsedOrphans === 'object') {
                    for (var orphanId in parsedOrphans) {
                        if (!parsedOrphans.hasOwnProperty(orphanId)) continue;
                        var orphan = parsedOrphans[orphanId];
                        if (orphan && orphan.channelId) {
                            loadedOrphans[String(orphan.channelId)] = orphan;
                        }
                    }
                }
                orphanChannels = loadedOrphans;
            }
            var rawCounters = store.get('eventCounters');
            if (rawCounters) {
                var parsedCounters = JSON.parse(rawCounters);
                if (parsedCounters && typeof parsedCounters === 'object') {
                    var templateCounter = parseInt(parsedCounters.template, 10);
                    var eventCounter = parseInt(parsedCounters.event, 10);
                    if (!isNaN(templateCounter) && templateCounter > nextTemplateId) nextTemplateId = templateCounter;
                    if (!isNaN(eventCounter) && eventCounter > nextEventId) nextEventId = eventCounter;
                }
            }
            for (var t = 0; t < templates.length; t++) {
                if (templates[t].id >= nextTemplateId) nextTemplateId = templates[t].id + 1;
            }
            for (var v = 0; v < events.length; v++) {
                if (events[v].id >= nextEventId) nextEventId = events[v].id + 1;
            }
        } catch (e) {
            logMessage('ERROR loading persisted data: ' + e.message, 1);
            templates = [];
            events = [];
            sessions = {};
        }
    }

    // ===== INITIALIZATION =====
    event.on('load', function() {
        logMessage('Event Manager v1.0.0 loaded');
        if (backend.isConnected()) {
            initialize();
        } else {
            event.on('connect', function() {
                initialize();
            });
        }
    });

    function initialize() {
        logMessage('Initializing...', 3);
        loadPersistedData();
        // A restart abandons any half-written template: delete the leftover
        // channel and forget the session rather than stranding the author in it.
        for (var uid in sessions) {
            if (!sessions.hasOwnProperty(uid)) continue;
            var session = sessions[uid];
            if (session.stage === 'template_edit') {
                deleteTemplateChannel(session);
            }
        }
        sessions = {};
        persistenceInitialized = true;
        saveData(); // persist the cleared sessions so the next boot starts clean
        dropExpiredEvents();
        retryOrphanChannels();
        updateBoard();
        setInterval(maintenance, 60 * 1000);
        logMessage('Ready. ' + templates.length + ' template(s), ' + upcomingEvents().length + ' upcoming event(s).', 3);
    }

    function maintenance() {
        dropExpiredEvents();
        expireSessions();
        reconcileTemplateChannels();
        retryOrphanChannels();
        updateBoard();
    }

    function expireSessions() {
        var now = Date.now();
        for (var uid in sessions) {
            if (!sessions.hasOwnProperty(uid)) continue;
            var session = sessions[uid];
            if (now - (session.updatedAt || 0) > sessionTimeoutMs) {
                cancelSession(uid, 'timed out');
            }
        }
    }

    // A deleted temp channel cancels just like "cancel template".
    function reconcileTemplateChannels() {
        for (var uid in sessions) {
            if (!sessions.hasOwnProperty(uid)) continue;
            var session = sessions[uid];
            if (session.stage !== 'template_edit' || !session.channelId) continue;
            if (!backend.getChannelByID(session.channelId)) {
                cancelTemplateSession(uid, 'channel removed');
            }
        }
    }

    // ===== COMMAND HANDLING =====
    event.on('chat', function(ev) {
        if (!ev.client || ev.client.isSelf()) {
            return;
        }
        var text = String(ev.text || '').trim();

        // !<listName> — read-only listing, open to everyone.
        if (text === '!' + listName) {
            listEventsInChat(ev.client);
            return;
        }

        if (text === '!' + botName || text.indexOf('!' + botName + ' ') === 0) {
            var args = text === '!' + botName ? '' : text.substring(botName.length + 1);
            handleEventCommand(args, ev.client);
        }
    });

    function handleEventCommand(args, invoker) {
        args = String(args || '').trim();
        var uid = clientKey(invoker);

        if (equalsIgnoreCase(args, 'help')) {
            displayHelp(invoker);
            return;
        }

        if (equalsIgnoreCase(args, 'cancel')) {
            if (!getSession(uid)) {
                invoker.chat('[EventManager] Nothing to cancel.');
                return;
            }
            cancelSession(uid, 'user cancelled');
            invoker.chat('[EventManager] Cancelled.');
            return;
        }

        if (!mayManageEvents(invoker)) {
            invoker.chat('[EventManager] Permission denied — you need to be in the event group to manage events.');
            return;
        }

        if (equalsIgnoreCase(args, 'templates')) {
            listTemplates(invoker);
            return;
        }

        var parts = args.split(/\s+/);
        var sub = parts[0] ? parts[0].toLowerCase() : '';

        if (sub === 'remove') {
            var removeIndex = parseInt(parts[1], 10);
            removeEvent(removeIndex, invoker);
            return;
        }

        if (sub === 'delete') {
            var deleteIndex = parseInt(parts[1], 10);
            deleteTemplate(deleteIndex, invoker);
            return;
        }

        if (args) {
            invoker.chat('[EventManager] Unknown option "' + args + '". Type !' + botName + ' help.');
            return;
        }

        startCommand(invoker, uid);
    }

    function displayHelp(invoker) {
        var t = '!' + botName;
        invoker.chat('[EventManager] EVENT COMMANDS:\n' +
            t + ' - Start planning an event (create a template or use an existing one)\n' +
            t + ' templates - List your templates\n' +
            t + ' delete <n> - Delete one of your templates\n' +
            t + ' remove <n> - Remove board event number <n>\n' +
            t + ' cancel - Cancel the command you are in the middle of\n' +
            t + ' help - Show this help\n' +
            '!' + listName + ' - List all upcoming events');
    }

    function startCommand(invoker, uid) {
        var mine = templatesOf(uid);
        var prompt = '[EventManager] What do you want to do? Reply with:\n' +
            '  new - create a new event template\n' +
            '  <number> - use one of your existing templates\n' +
            '  !' + botName + ' cancel - abort\n';
        if (mine.length) {
            var lines = '';
            for (var i = 0; i < mine.length; i++) {
                lines += '  ' + (i + 1) + '. ' + mine[i].name + '\n';
            }
            prompt += 'Your templates:\n' + lines;
        } else {
            prompt += 'You have no templates yet.\n';
        }
        setSession(uid, {
            stage: 'choose',
            ownerUid: uid,
            ownerName: invoker.name()
        });
        invoker.chat(prompt);
    }

    function listTemplates(invoker) {
        var uid = clientKey(invoker);
        var mine = templatesOf(uid);
        if (!mine.length) {
            invoker.chat('[EventManager] You have no templates. Type !' + botName + ' and reply "new" to create one.');
            return;
        }
        var lines = '[EventManager] Your templates:\n';
        for (var i = 0; i < mine.length; i++) {
            lines += '  ' + (i + 1) + '. ' + mine[i].name + '\n';
        }
        lines += 'Delete one with !' + botName + ' delete <n>.';
        invoker.chat(lines);
    }

    function deleteTemplate(index, invoker) {
        if (isNaN(index) || index < 1) {
            invoker.chat('Usage: !' + botName + ' delete <n>');
            return;
        }
        var uid = clientKey(invoker);
        var mine = templatesOf(uid);
        if (index > mine.length) {
            invoker.chat('[EventManager] No template number ' + index + '.');
            return;
        }
        var target = mine[index - 1];
        var kept = [];
        for (var i = 0; i < templates.length; i++) {
            if (templates[i] !== target) kept.push(templates[i]);
        }
        templates = kept;
        if (persistenceInitialized) saveData();
        invoker.chat('[EventManager] Template "' + target.name + '" deleted.');
        logMessage('Template "' + target.name + '" deleted by ' + invoker.name() + '.', 3);
    }

    function removeEvent(index, invoker) {
        if (isNaN(index) || index < 1) {
            invoker.chat('Usage: !' + botName + ' remove <n> (see !' + listName + ')');
            return;
        }
        var list = upcomingEvents();
        if (index > list.length) {
            invoker.chat('[EventManager] No event number ' + index + '. Use !' + listName + ' to see the list.');
            return;
        }
        var target = list[index - 1];
        if (target.ownerUid !== clientKey(invoker) && !isAdmin(invoker)) {
            invoker.chat('[EventManager] Permission denied — only the event owner or an admin can remove it.');
            return;
        }
        var kept = [];
        for (var i = 0; i < events.length; i++) {
            if (events[i] !== target) kept.push(events[i]);
        }
        events = kept;
        if (persistenceInitialized) saveData();
        updateBoard();
        invoker.chat('[EventManager] Removed "' + target.templateName + '" on ' + formatBoardStamp(target.startMs) + '.');
    }

    function listEventsInChat(client) {
        var list = upcomingEvents();
        if (!list.length) {
            client.chat('[EventManager] No upcoming events.');
            return;
        }
        var lines = '[EventManager] Upcoming events (' + list.length + '):\n';
        for (var i = 0; i < list.length; i++) {
            lines += '  ' + (i + 1) + '. ' + list[i].templateName + ' — ' + formatBoardStamp(list[i].startMs) +
                ' (by ' + list[i].ownerName + ')\n';
        }
        lines += 'Remove one with !' + botName + ' remove <n>.';
        client.chat(lines);
    }

    // ===== MULTI-STAGE FLOW =====
    function startTemplateCreation(invoker, uid) {
        setSession(uid, {
            stage: 'template_name',
            ownerUid: uid,
            ownerName: invoker.name()
        });
        invoker.chat('[EventManager] What should the template be called? Reply with the name, or !' +
            botName + ' cancel to abort.');
    }

    function openTemplateEditor(invoker, uid, name) {
        var channel = createTemplateChannel(name, invoker.name());
        if (!channel) {
            clearSession(uid);
            invoker.chat('[EventManager] Could not create a template channel. Check the TEMPLATE_PARENT_CHANNEL_ID / EVENT_CHANNEL_ID setting.');
            return;
        }
        setSession(uid, {
            stage: 'template_edit',
            ownerUid: uid,
            ownerName: invoker.name(),
            templateName: name,
            channelId: channel.id()
        });

        var granted = grantChannelAdmin(invoker, channel.id());
        try {
            invoker.moveTo(channel);
        } catch (e) {
            logMessage('ERROR moving ' + invoker.name() + ' into template channel: ' + e.message, 1);
        }
        if (stickyChannelId) {
            try {
                backend.getBotClient().moveTo(channel.id());
            } catch (e) {
                logMessage('WARNING: bot could not follow into template channel: ' + e.message, 2);
            }
        }

        if (!granted) {
            invoker.chat('[EventManager] Warning: I could not grant you channel admin, so you may not be able to edit the description. Ask an admin to set the channel admin group.');
        }
        invoker.chat('[EventManager] You are now in "' + channel.name() + '".\n' +
            'Open the channel information and write your event template into the DESCRIPTION.\n' +
            'Use {date} and {time} where the date and time go, e.g.:\n' +
            '[b]Raid[/b] — {date} at {time}\nJoin voice channel 1.\n\n' +
            'When you are done type "save template" here, or "cancel template" to discard it.');
    }

    function saveTemplateFromEditor(invoker, uid) {
        var session = getSession(uid);
        if (!session || session.stage !== 'template_edit') {
            invoker.chat('[EventManager] You have no template in progress.');
            return;
        }
        var name = session.templateName;
        var ownerName = session.ownerName;
        var channel = backend.getChannelByID(session.channelId);
        var text = '';
        if (channel) {
            try {
                text = String(channel.description() || '');
            } catch (e) {
                logMessage('ERROR reading template channel description: ' + e.message, 1);
            }
        }
        // An untouched description still holds the bot's own instructions —
        // that is not a template.
        if (text.trim() === templateChannelDescription(ownerName)) {
            invoker.chat('[EventManager] The description still only contains my instructions. ' +
                'Write your event template in the channel information first, then type "save template".');
            return;
        }
        if (!text.trim()) {
            invoker.chat('[EventManager] The channel description is still empty — write your template there first, then type "save template".');
            return;
        }
        deleteTemplateChannel(session);
        clearSession(uid);
        var tpl = saveTemplate(uid, ownerName, name, text);
        logMessage('Saved template "' + tpl.name + '" for ' + ownerName + '.', 3);
        invoker.chat('[EventManager] Template "' + tpl.name + '" saved. Use !' + botName +
            ' and reply with its number to plan an event with it.');
    }

    function askTemplateSelection(invoker, uid) {
        var mine = templatesOf(uid);
        if (!mine.length) {
            clearSession(uid);
            invoker.chat('[EventManager] You have no templates. Type !' + botName + ' and reply "new" to create one.');
            return;
        }
        var lines = '[EventManager] Which template do you want to use? Reply with the number, or !' + botName + ' cancel to abort.\n';
        for (var i = 0; i < mine.length; i++) {
            lines += '  ' + (i + 1) + '. ' + mine[i].name + '\n';
        }
        setSession(uid, {
            stage: 'pick_template',
            ownerUid: uid,
            ownerName: invoker.name(),
            templateIndex: 0
        });
        invoker.chat(lines);
    }

    function askDate(invoker, uid, template) {
        setSession(uid, {
            stage: 'ask_date',
            ownerUid: uid,
            ownerName: invoker.name(),
            templateId: template.id,
            templateName: template.name
        });
        invoker.chat('[EventManager] What date is "' + template.name + '" on?\n' +
            'Format: DD/MM/YYYY — for example 04/10/2026 means 4 October 2026.\n' +
            'Reply with the date, or !' + botName + ' cancel to abort.');
    }

    function askTime(invoker, uid, template, date) {
        setSession(uid, {
            stage: 'ask_time',
            ownerUid: uid,
            ownerName: invoker.name(),
            templateId: template.id,
            templateName: template.name,
            date: date
        });
        invoker.chat('[EventManager] What time does "' + template.name + '" start? (24 hour clock)\n' +
            'Format: HH:MM — for example 20:00, or 08:30.\n' +
            'Reply with the time, or !' + botName + ' cancel to abort.');
    }

    function publishEvent(invoker, uid, template, startMs) {
        var entry = {
            id: nextEventId++,
            templateId: template.id,
            templateName: template.name,
            text: renderTemplate(template.text, startMs),
            startMs: startMs,
            ownerUid: uid,
            ownerName: invoker.name(),
            createdAt: new Date().toISOString()
        };
        events.push(entry);
        if (persistenceInitialized) saveData();
        updateBoard();
        invoker.chat('[EventManager] "' + entry.templateName + '" scheduled for ' +
            formatBoardStamp(startMs) + ' and posted to the board.');
        logMessage('Event #' + entry.id + ' "' + entry.templateName + '" scheduled by ' +
            invoker.name() + ' for ' + formatBoardStamp(startMs) + '.', 3);
    }

    function findTemplateById(uid, id) {
        var mine = templatesOf(uid);
        for (var i = 0; i < mine.length; i++) {
            if (mine[i].id === id) return mine[i];
        }
        return null;
    }

    // Capture handler: every non-command reply from a user with an open session.
    event.on('chat', function(ev) {
        if (!ev.client || ev.client.isSelf()) {
            return;
        }
        var uid = clientKey(ev.client);
        var session = getSession(uid);
        if (!session) {
            return;
        }
        var text = String(ev.text || '').trim();
        if (!text || text.charAt(0) === '!') {
            return; // commands (including !event cancel) go to the dispatcher
        }

        if (session.stage === 'template_edit') {
            if (equalsIgnoreCase(text, 'save template')) {
                saveTemplateFromEditor(ev.client, uid);
                return;
            }
            if (equalsIgnoreCase(text, 'cancel template')) {
                cancelTemplateSession(uid, 'user cancelled');
                ev.client.chat('[EventManager] Template discarded.');
                return;
            }
            ev.client.chat('[EventManager] Type "save template" when the description is done, or "cancel template" to discard it.');
            return;
        }

        if (session.stage === 'choose') {
            if (equalsIgnoreCase(text, 'new')) {
                startTemplateCreation(ev.client, uid);
                return;
            }
            var chosen = parseInt(text, 10);
            var mine = templatesOf(uid);
            if (!isNaN(chosen) && chosen >= 1 && chosen <= mine.length) {
                var template = mine[chosen - 1];
                askDate(ev.client, uid, template);
                return;
            }
            ev.client.chat('[EventManager] Reply with "new", the number of a template, or !' + botName + ' cancel.');
            return;
        }

        if (session.stage === 'template_name') {
            var name = String(text).trim();
            if (name.length > 30) {
                ev.client.chat('[EventManager] Please keep the template name under 30 characters.');
                return;
            }
            if (findTemplateByName(uid, name)) {
                ev.client.chat('[EventManager] You already have a template called "' + name + '". Saving will overwrite it. Type the name again to overwrite, or !' + botName + ' cancel.');
                session.stage = 'template_name_overwrite';
                setSession(uid, session);
                return;
            }
            openTemplateEditor(ev.client, uid, name);
            return;
        }

        if (session.stage === 'template_name_overwrite') {
            openTemplateEditor(ev.client, uid, String(text).trim());
            return;
        }

        if (session.stage === 'pick_template') {
            var pick = parseInt(text, 10);
            var list = templatesOf(uid);
            if (isNaN(pick) || pick < 1 || pick > list.length) {
                ev.client.chat('[EventManager] Reply with the number of a template from the list, or !' + botName + ' cancel.');
                return;
            }
            askDate(ev.client, uid, list[pick - 1]);
            return;
        }

        if (session.stage === 'ask_date') {
            var parsedDate = parseDateInput(text);
            if (!parsedDate) {
                ev.client.chat('[EventManager] I could not read that date. Use DD/MM/YYYY, for example 04/10/2026.');
                return;
            }
            var dateTemplate = findTemplateById(uid, session.templateId);
            if (!dateTemplate) {
                clearSession(uid);
                ev.client.chat('[EventManager] That template no longer exists. Start again with !' + botName + '.');
                return;
            }
            askTime(ev.client, uid, dateTemplate, parsedDate);
            return;
        }

        if (session.stage === 'ask_time') {
            var parsedTime = parseTimeInput(text);
            if (!parsedTime) {
                ev.client.chat('[EventManager] I could not read that time. Use HH:MM in 24 hour format, for example 20:00.');
                return;
            }
            var timeTemplate = findTemplateById(uid, session.templateId);
            if (!timeTemplate) {
                clearSession(uid);
                ev.client.chat('[EventManager] That template no longer exists. Start again with !' + botName + '.');
                return;
            }
            var date = session.date;
            var startMs = epochFromWallClock(date.year, date.month, date.day, parsedTime.hour, parsedTime.minute);
            clearSession(uid);
            publishEvent(ev.client, uid, timeTemplate, startMs);
            return;
        }
    });

    // Leaving the template channel cancels it.
    event.on('clientMove', function(ev) {
        if (!ev.client || ev.client.isSelf() || !ev.toChannel) {
            return;
        }
        var uid = clientKey(ev.client);
        var session = getSession(uid);
        if (!session || session.stage !== 'template_edit' || !session.channelId) {
            return;
        }
        if (String(ev.toChannel.id()) === String(session.channelId)) {
            return;
        }
        cancelTemplateSession(uid, 'author left the channel');
        logMessage('Author left the template channel — session cancelled for ' + session.ownerName + '.', 3);
    });
});