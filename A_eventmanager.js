// Event Manager Plugin v1.0 for SinusBot
// Complete event management system for sea battle guilds (Goud Graaiers)
// Support for event templates, scheduling, auto poke reminders, sign up attendance
// Follows the same pattern as A_bountyboard.js with OKlib integration

registerPlugin({
    name: 'Event Manager',
    version: '0.0.1',
    author: 'FuelClock',
    description: 'Complete event management system with persistent storage',
    backends: ['ts3'],
    vars: [
        { name: 'BOT_NAME', title: 'Bot Command Name', type: 'string', default: 'event' },
        { name: 'CREATOR_GROUP', title: 'Server Group ID (can create events)', type: 'string', default: '3' },
        { name: 'ADMIN_GROUP', title: 'Server Group ID (admin)', type: 'string', default: '17' },
        { name: 'SIGNUP_GROUP', title: 'Server Group ID (can sign up)', type: 'string', default: '23' },
        { name: 'EVENT_CHANNEL_ID', title: 'Channel for event display', type: 'channel' },
        { name: 'REMINDER_INTERVALS', title: 'Reminder minutes before event (comma-separated)', type: 'string', default: '30,5' },
        { name: 'AUTO_CLEAR_HOURS', title: 'Hours after start before auto-clearing (0 = disabled)', type: 'number', default: '4' },
        { name: 'TIMEZONE', title: 'Timezone (IANA)', type: 'string', default: 'Europe/Amsterdam' },
        { name: 'MAX_ATTENDEES', title: 'Max attendees per event', type: 'number', default: '50' },
        { name: 'DEFAULT_EVENT_DURATION', title: 'Default event duration (minutes)', type: 'number', default: '120' }
    ],
    requiredModules: ['engine', 'backend', 'event', 'store'],
    autorun: false
}, function(_, config, meta) {
    const engine = require('engine');
    const backend = require('backend');
    const event = require('event');

    var botName = config.BOT_NAME || 'event';
    var creatorGroupId = String(config.CREATOR_GROUP || '3');
    var adminGroupId = String(config.ADMIN_GROUP || '17');
    var signupGroupId = String(config.SIGNUP_GROUP || '23');
    var eventChannelId = String(config.EVENT_CHANNEL_ID || '');
    var reminderIntervals = String(config.REMINDER_INTERVALS || '30,5').split(',').map(Number);
    var autoClearHours = parseInt(config.AUTO_CLEAR_HOURS) || 4;
    var timezone = config.TIMEZONE || 'Europe/Amsterdam';
    var maxAttendees = parseInt(config.MAX_ATTENDEES) || 50;
    var defaultEventDuration = parseInt(config.DEFAULT_EVENT_DURATION) || 120;

    // ===== PERSISTENCE =====
    var events = [];
    var eventReminders = {};
    var eventChannel = null;
    var autoClearInterval = null;
    var persistenceInitialized = false;
    var store = null;

    // ===== STORE MODULE =====
    try {
        store = require('store');
        logMessage('Store module loaded for persistence', 3);
    } catch (e) {
        logMessage('FATAL: Store module unavailable — persistence disabled. Add "store" to requiredModules in manifest.', 1);
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
        logMessage('WARNING: OKlib could not be loaded: ' + e.message, 2);
    }

    if (!oklibAvailable) {
        logMessage('WARNING: OKlib 1.0.6+ unavailable — using manual implementations', 2);
    } else {
        logMessage('OKlib loaded successfully (v1.0.6+)', 3);
    }

    function logMessage(message, level) {
        if (oklibAvailable && oklib.general && typeof oklib.general.log === 'function') {
            oklib.general.log(message, level || 4);
            return;
        }
        engine.log(message);
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

    function startsWithIgnoreCase(value, prefix) {
        value = String(value || '');
        prefix = String(prefix || '');
        return equalsIgnoreCase(value.substring(0, prefix.length), prefix);
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

    function searchClients(query, partMatch, caseSensitive, clients) {
        if (oklibAvailable && oklib.client && typeof oklib.client.search === 'function') {
            return oklib.client.search(query, partMatch, caseSensitive, clients);
        }

        var searchPool = Array.isArray(clients) ? clients : backend.getClients();
        var searchTerm = String(query || '');
        var results = [];
        for (var i = 0; i < searchPool.length; i++) {
            var client = searchPool[i];
            var clientName = typeof client.name === 'function' ? client.name() : String(client.name || '');
            var nameMatches = caseSensitive
                ? clientName === searchTerm
                : equalsIgnoreCase(clientName, searchTerm);
            if (partMatch) {
                nameMatches = caseSensitive
                    ? clientName.indexOf(searchTerm) !== -1
                    : containsIgnoreCase(clientName, searchTerm);
            }

            if (nameMatches || String(client.uid ? client.uid() : '').indexOf(searchTerm) !== -1 ||
                String(client.id ? client.id() : '').indexOf(searchTerm) !== -1) {
                results.push(client);
            }
        }
        return results;
    }

    function isCreator(invoker) {
        return isMemberOfOne(invoker, [creatorGroupId]);
    }

    function isAdmin(invoker) {
        return isMemberOfOne(invoker, [adminGroupId]);
    }

    function isSignupAllowed(invoker) {
        return isMemberOfOne(invoker, [signupGroupId]);
    }

    if (!oklibAvailable) {
        oklib = {
            general: {
                checkVersion: function() { return false; },
                log: logMessage
            },
            client: {
                search: searchClients,
                isMemberOfOne: isMemberOfOne
            },
            comparator: {
                containsIgnoreCase: containsIgnoreCase
            }
        };
    }

    // ===== SCRIPT INITIALIZATION =====
    event.on('load', function(ev) {
        logMessage('Event Manager v1.0 loaded');
        logMessage('Configuration - BotName: ' + botName + ', CreatorGroup: ' + creatorGroupId + ', SignupGroup: ' + signupGroupId + ', EventChannel: ' + eventChannelId);

        if (backend.isConnected()) {
            initialize();
        } else {
            event.on('connect', function() {
                initialize();
            });
        }
    });

    function initialize() {
        logMessage('Initializing event manager system...');
        loadPersistedData();
        initializeEventChannel();
        startAutoClear();
        persistenceInitialized = true;
        logMessage('Initialization complete. Loaded ' + events.length + ' events');
    }

    function initializeEventChannel() {
        if (eventChannelId) {
            eventChannel = backend.getChannelByID(eventChannelId);
            if (eventChannel) {
                logMessage('Event channel initialized: ' + eventChannelId);
            } else {
                logMessage('WARNING: Event channel ' + eventChannelId + ' not found', 2);
            }
        } else {
            // Try to find existing events channel
            var channels = backend.getChannels();
            for (var i = 0; i < channels.length; i++) {
                if (containsIgnoreCase(channels[i].name(), 'event') || containsIgnoreCase(channels[i].name(), 'events')) {
                    eventChannelId = String(channels[i].id());
                    eventChannel = channels[i];
                    logMessage('Found existing events channel: ' + eventChannelId);
                    break;
                }
            }
            // If still no channel, we'll try to create one later when needed
        }
    }

    // ===== EVENT HANDLERS =====
    event.on('chat', function(ev) {
        if (ev.client.isSelf()) {
            return;
        }

        // Event commands: !<botName> <subcommand>
        var prefix = '!' + botName + ' ';
        if (ev.text.startsWith(prefix)) {
            var cmdText = ev.text.substring(prefix.length);
            logMessage('EVENT COMMAND from ' + ev.client.name() + ': ' + cmdText, 4);
            handleEventCommand(cmdText, ev);
        }
    });

    // ===== COMMAND HANDLING =====
    function handleEventCommand(args, ev) {
        var invoker = ev.client;

        var invokerIsAdmin = isAdmin(invoker);
        var invokerIsCreator = isCreator(invoker);
        var invokerCanSignup = isSignupAllowed(invoker);

        // Diagnostic: log group membership to troubleshoot permission issues
        var invokerGroupIds = [];
        if (invoker && typeof invoker.getServerGroups === 'function') {
            var rawGroups = invoker.getServerGroups();
            for (var gi = 0; gi < rawGroups.length; gi++) {
                invokerGroupIds.push(rawGroups[gi].id());
            }
        }
        logMessage('AUTH CHECK: ' + invoker.name() + ' groups=[' + invokerGroupIds.join(',') + '] creatorGroup=' + creatorGroupId + ' adminGroup=' + adminGroupId + ' signupGroup=' + signupGroupId + ' >> creator=' + invokerIsCreator + ' admin=' + invokerIsAdmin + ' signup=' + invokerCanSignup, 3);

        if (!invokerIsAdmin && !invokerIsCreator) {
            invoker.chat('[EventManager] Permission denied');
            return;
        }

        var parts = args.trim().split(/\s+/);
        var subCommand = parts[0].toLowerCase();

        if (subCommand === 'test') {
            invoker.chat('[EventManager] v1.0 test OK — authorized');
            return;
        }

        if (subCommand === 'help') {
            displayEventHelp(ev);
            return;
        }

        // Event creation from template
        if (subCommand === 'create') {
            if (parts.length < 3) {
                invoker.chat('Usage: !event create <template|custom> <date> <time> [recurrence] [duration]');
                return;
            }
            handleCreateEvent(parts.slice(1), ev);
            return;
        }

        // Event listing
        if (subCommand === 'list') {
            if (parts.length < 1) {
                displayEventList(ev);
            } else {
                var filter = parts[1].toLowerCase();
                if (filter === 'active' || filter === 'upcoming' || filter === 'completed' || filter === 'cancelled') {
                    displayEventList(ev, filter);
                } else {
                    invoker.chat('Usage: !event list [active|upcoming|completed|cancelled]');
                }
            }
            return;
        }

        // Event info
        if (subCommand === 'info') {
            if (parts.length < 2) {
                invoker.chat('Usage: !event info <eventId>');
                return;
            }
            displayEventInfo(parts[1], ev);
            return;
        }

        // Event sign-up
        if (subCommand === 'sign') {
            if (parts.length < 2) {
                invoker.chat('Usage: !event sign <eventId> [shipClass]');
                return;
            }
            handleSignUp(parts[1], parts[2], ev);
            return;
        }

        // Event sign-off
        if (subCommand === 'signoff') {
            if (parts.length < 2) {
                invoker.chat('Usage: !event signoff <eventId>');
                return;
            }
            handleSignOff(parts[1], ev);
            return;
        }

        // Event attendance
        if (subCommand === 'attendees') {
            if (parts.length < 2) {
                invoker.chat('Usage: !event attendees <eventId>');
                return;
            }
            displayEventAttendees(parts[1], ev);
            return;
        }

        // Event edit
        if (subCommand === 'edit') {
            if (parts.length < 3) {
                invoker.chat('Usage: !event edit <eventId> <field> <value>');
                return;
            }
            handleEditEvent(parts[1], parts[2], parts.slice(3).join(' '), ev);
            return;
        }

        // Event cancel
        if (subCommand === 'cancel') {
            if (parts.length < 2) {
                invoker.chat('Usage: !event cancel <eventId> [reason]');
                return;
            }
            handleCancelEvent(parts[1], parts.slice(2).join(' '), ev);
            return;
        }

        // Event complete
        if (subCommand === 'complete') {
            if (parts.length < 2) {
                invoker.chat('Usage: !event complete <eventId>');
                return;
            }
            handleCompleteEvent(parts[1], ev);
            return;
        }

        // Event clone
        if (subCommand === 'clone') {
            if (parts.length < 3) {
                invoker.chat('Usage: !event clone <templateId> <date> <time>');
                return;
            }
            handleCloneEvent(parts[1], parts[2], parts[3], ev);
            return;
        }

        // Event remove
        if (subCommand === 'remove') {
            if (parts.length < 2) {
                invoker.chat('Usage: !event remove <eventId>');
                return;
            }
            handleRemoveEvent(parts[1], ev);
            return;
        }

        // Server groups list
        if (subCommand === 'servergroups') {
            listServerGroups(ev);
            return;
        }

        // Event mute/unmute
        if (subCommand === 'mute') {
            if (parts.length < 2) {
                invoker.chat('Usage: !event mute <eventId>');
                return;
            }
            handleMuteEvent(parts[1], ev);
            return;
        }

        if (subCommand === 'unmute') {
            if (parts.length < 2) {
                invoker.chat('Usage: !event unmute <eventId>');
                return;
            }
            handleUnmuteEvent(parts[1], ev);
            return;
        }

        // Event stats
        if (subCommand === 'stats') {
            if (parts.length < 2) {
                invoker.chat('Usage: !event stats [week|month]');
                return;
            }
            displayEventStats(parts[1], ev);
            return;
        }

        invoker.chat('Unknown event command. Usage: !event help');
    }

    // ===== BUILT-IN TEMPLATES =====
    var BUILT_IN_TEMPLATES = {
        thunder: {
            id: 'thunder',
            name: 'Thursday Thunder',
            description: 'Imp hunt — sink as many Imperials as possible',
            location: 'Devios Bay',
            goal: 'Bring thunder to the Lightning and any other Imperial ship in our waters',
            missionNeeds: {
                shipClass: 'Class 4 or up',
                hp: '7k',
                armor: '15',
                ammo: 'plenty',
                repair: 'plenty'
            },
            strategy: 'Drop barrels, fire main cannons, outmanoeuvre Imps',
            additionalInfo: 'Any pirate we meet can also be sunk, but Imperials have priority. Have fun and practise formations!',
            defaultTime: '20:00',
            defaultDuration: 120,
            reminderMinutes: [30, 5],
            tags: ['pve', 'imp-hunt', 'weekly']
        }
    };

    // ===== EVENT CREATION =====
    function handleCreateEvent(parts, ev) {
        var invoker = ev.client;

        if (!invokerIsCreator && !invokerIsAdmin) {
            invoker.chat('[EventManager] Permission denied');
            return;
        }

        if (parts.length < 3) {
            invoker.chat('Usage: !event create <template|custom> <date> <time> [recurrence] [duration]');
            return;
        }

        var source = parts[0].toLowerCase();
        var date = parts[1];
        var time = parts[2];
        var recurrence = parts[3] || 'none';
        var duration = parts[4] ? parseInt(parts[4]) : defaultEventDuration;

        var eventData;
        if (source === 'custom') {
            // Custom event creation (need more fields)
            invoker.chat('Custom event creation requires additional fields. Use template instead for now.');
            return;
        } else {
            eventData = createEventFromTemplate(source, date, time, recurrence, duration, invoker);
        }

        if (!eventData) {
            return;
        }

        // Validate date and time format
        if (!/\d{4}-\d{2}-\d{2}/.test(eventData.date)) {
            invoker.chat('Invalid date format. Use YYYY-MM-DD');
            return;
        }
        if (!/\d{2}:\d{2}/.test(eventData.time)) {
            invoker.chat('Invalid time format. Use HH:MM (24h)');
            return;
        }

        // Check if event already exists at same time
        for (var i = 0; i < events.length; i++) {
            if (events[i].date === eventData.date && events[i].time === eventData.time &&
                (events[i].status === 'scheduled' || events[i].status === 'active')) {
                invoker.chat('[EventManager] Event already scheduled at this time');
                return;
            }
        }

        // Add event
        eventData.id = Date.now();
        eventData.postedBy = invoker.name();
        eventData.createdAt = new Date().toISOString();
        eventData.updatedAt = new Date().toISOString();
        eventData.attendees = [];
        eventData.remindersSent = [];
        eventData.attendeesConfirmed = 0;
        eventData.attendeesPending = 0;

        events.push(eventData);
        if (persistenceInitialized) {
            saveData();
        }

        // Schedule reminders
        scheduleEventReminders(eventData);

        // Update channel description
        updateChannelDescription();

        invoker.chat('Event created: ' + eventData.name + ' on ' + eventData.date + ' at ' + eventData.time + ' (' + eventData.recurrence + ')');

        // Notify in event channel
        if (eventChannel) {
            eventChannel.chat('[EventManager] ' + invoker.name() + ' created event: ' + eventData.name + ' on ' + eventData.date + ' at ' + eventData.time);
        }
    }

    function createEventFromTemplate(templateId, date, time, recurrence, duration, invoker) {
        var template = BUILT_IN_TEMPLATES[templateId];
        if (!template) {
            invoker.chat('[EventManager] Unknown template: ' + templateId);
            return null;
        }

        // Parse and validate date/time
        var eventDate = new Date(date + ' ' + time + ':00');
        if (isNaN(eventDate.getTime())) {
            invoker.chat('[EventManager] Invalid date or time');
            return null;
        }

        var eventTime = time;
        if (!/\d{2}:\d{2}/.test(time)) {
            // Try to parse common formats
            if (/\d{1,2}:\d{2} [AP]M/.test(time)) {
                // TODO: Convert to 24h format
                invoker.chat('[EventManager] Please use HH:MM 24h format');
                return null;
            }
            invoker.chat('[EventManager] Invalid time format. Use HH:MM (24h)');
            return null;
        }

        // Convert to ISO date for storage
        var isoDate = eventDate.toISOString().split('T')[0];

        var eventData = {
            id: Date.now(),
            templateId: templateId,
            name: template.name,
            description: template.description,
            location: template.location,
            goal: template.goal,
            missionNeeds: template.missionNeeds,
            strategy: template.strategy,
            additionalInfo: template.additionalInfo || '',
            date: isoDate,
            time: eventTime,
            duration: duration,
            recurrence: recurrence,
            status: 'scheduled',
            reminderMinutes: template.reminderMinutes || [30, 5],
            tags: template.tags || [],
            host: invoker.name(),
            attendees: [],
            remindersSent: [],
            attendeesConfirmed: 0,
            attendeesPending: 0,
            mutedAttendees: [],
            postedBy: invoker.name(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        return eventData;
    }

    function scheduleEventReminders(event) {
        var eventTime = new Date(event.date + 'T' + event.time).getTime();
        var reminders = event.reminderMinutes || [];

        reminders.forEach(function(minutes) {
            var reminderTime = eventTime - (minutes * 60000);
            var delay = reminderTime - Date.now();

            if (delay > 0) {
                var timerKey = event.id + '_' + minutes;
                var timer = setTimeout(function() {
                    sendEventReminder(event, minutes);
                }, delay);
                eventReminders[timerKey] = timer;
            }
        });
    }

    function sendEventReminder(event, minutesBefore) {
        var channel = eventChannel;
        if (!channel) {
            return;
        }

        var confirmedAttendees = event.attendees.filter(function(a) { return a.confirmed && !a.muted; });

        // Send reminder to attendees
        confirmedAttendees.forEach(function(attendee) {
            var client = findClientByName(attendee.name);
            if (client) {
                client.poke('[EventManager] ⚓ ' + event.name + ' starts in ' + minutesBefore + ' min! Location: ' + event.location);
            }
        });

        // Post to event channel
        channel.chat('[EventManager] ⚓ ' + event.name + ' starts in ' + minutesBefore + ' min! (' + confirmedAttendees.length + ' confirmed)');

        // Mark reminder as sent
        if (!event.remindersSent.includes(minutesBefore)) {
            event.remindersSent.push(minutesBefore);
            if (persistenceInitialized) {
                saveData();
            }
        }
    }

    // ===== EVENT COMMANDS =====
    function handleSignUp(eventId, shipClass, ev) {
        var invoker = ev.client;
        var eventIndex = findEventById(eventId);

        if (eventIndex === -1) {
            invoker.chat('[EventManager] Event not found: ' + eventId);
            return;
        }

        var eventData = events[eventIndex];

        if (eventData.status !== 'scheduled' && eventData.status !== 'active') {
            invoker.chat('[EventManager] Event is not accepting sign-ups');
            return;
        }

        if (!isSignupAllowed(invoker)) {
            invoker.chat('[EventManager] Permission denied — you must be in the signup group');
            return;
        }

        // Check if already signed up
        for (var i = 0; i < eventData.attendees.length; i++) {
            if (eventData.attendees[i].name === invoker.name()) {
                invoker.chat('[EventManager] You are already signed up for this event');
                return;
            }
        }

        // Check max attendees
        if (eventData.attendees.length >= maxAttendees) {
            invoker.chat('[EventManager] Event is full');
            return;
        }

        var attendee = {
            name: invoker.name(),
            shipClass: shipClass || 'Any',
            signedAt: new Date().toISOString(),
            confirmed: false,
            muted: false
        };

        eventData.attendees.push(attendee);
        eventData.attendeesPending++;

        if (persistenceInitialized) {
            saveData();
        }

        updateChannelDescription();

        invoker.chat('[EventManager] Signed up for ' + eventData.name + ' (ship class: ' + attendee.shipClass + ')');

        // Notify host
        var hostClient = findClientByName(eventData.host);
        if (hostClient) {
            hostClient.poke('[EventManager] New sign-up for ' + eventData.name + ' by ' + invoker.name());
        }
    }

    function handleSignOff(eventId, ev) {
        var invoker = ev.client;
        var eventIndex = findEventById(eventId);

        if (eventIndex === -1) {
            invoker.chat('[EventManager] Event not found: ' + eventId);
            return;
        }

        var eventData = events[eventIndex];

        if (eventData.status !== 'scheduled' && eventData.status !== 'active') {
            invoker.chat('[EventManager] Event is not accepting sign-offs');
            return;
        }

        // Find attendee
        for (var i = 0; i < eventData.attendees.length; i++) {
            if (eventData.attendees[i].name === invoker.name()) {
                eventData.attendees.splice(i, 1);
                eventData.attendeesPending--;
                break;
            }
        }

        if (persistenceInitialized) {
            saveData();
        }

        updateChannelDescription();

        invoker.chat('[EventManager] Signed off from ' + eventData.name);
    }

    function handleEditEvent(eventId, field, value, ev) {
        var invoker = ev.client;
        var eventIndex = findEventById(eventId);

        if (eventIndex === -1) {
            invoker.chat('[EventManager] Event not found: ' + eventId);
            return;
        }

        var eventData = events[eventIndex];

        if (eventData.status === 'active' || eventData.status === 'completed') {
            invoker.chat('[EventManager] Cannot edit active or completed events');
            return;
        }

        // Check permissions
        if (!invokerIsCreator && !invokerIsAdmin) {
            invoker.chat('[EventManager] Permission denied');
            return;
        }

        // Update field
        switch (field.toLowerCase()) {
            case 'name':
                eventData.name = value;
                break;
            case 'date':
                // Validate date format
                if (!/\d{4}-\d{2}-\d{2}/.test(value)) {
                    invoker.chat('[EventManager] Invalid date format. Use YYYY-MM-DD');
                    return;
                }
                eventData.date = value;
                break;
            case 'time':
                // Validate time format
                if (!/\d{2}:\d{2}/.test(value)) {
                    invoker.chat('[EventManager] Invalid time format. Use HH:MM (24h)');
                    return;
                }
                eventData.time = value;
                break;
            case 'location':
                eventData.location = value;
                break;
            case 'goal':
                eventData.goal = value;
                break;
            case 'recurrence':
                eventData.recurrence = value;
                break;
            default:
                invoker.chat('[EventManager] Unknown field: ' + field);
                return;
        }

        eventData.updatedAt = new Date().toISOString();

        if (persistenceInitialized) {
            saveData();
        }

        updateChannelDescription();

        invoker.chat('[EventManager] Event updated: ' + field + ' = ' + value);
    }

    function handleCancelEvent(eventId, reason, ev) {
        var invoker = ev.client;
        var eventIndex = findEventById(eventId);

        if (eventIndex === -1) {
            invoker.chat('[EventManager] Event not found: ' + eventId);
            return;
        }

        var eventData = events[eventIndex];

        if (eventData.status !== 'scheduled') {
            invoker.chat('[EventManager] Can only cancel scheduled events');
            return;
        }

        // Check permissions
        if (eventData.host !== invoker.name() && !invokerIsAdmin) {
            invoker.chat('[EventManager] Permission denied — only host can cancel');
            return;
        }

        eventData.status = 'cancelled';
        eventData.cancelledBy = invoker.name();
        eventData.cancelledAt = new Date().toISOString();
        eventData.cancellationReason = reason;
        eventData.updatedAt = new Date().toISOString();

        // Clear reminders
        clearEventReminders(eventData);

        if (persistenceInitialized) {
            saveData();
        }

        updateChannelDescription();

        invoker.chat('[EventManager] Event cancelled: ' + reason);

        // Notify attendees
        var channel = eventChannel;
        if (channel) {
            channel.chat('[EventManager] ⚓ Event CANCELLED: ' + eventData.name + ' — ' + reason);
        }
    }

    function handleCompleteEvent(eventId, ev) {
        var invoker = ev.client;
        var eventIndex = findEventById(eventId);

        if (eventIndex === -1) {
            invoker.chat('[EventManager] Event not found: ' + eventId);
            return;
        }

        var eventData = events[eventIndex];

        if (eventData.status !== 'active') {
            invoker.chat('[EventManager] Can only complete active events');
            return;
        }

        // Check permissions
        if (!invokerIsAdmin && eventData.host !== invoker.name()) {
            invoker.chat('[EventManager] Permission denied — only host or admin can complete');
            return;
        }

        eventData.status = 'completed';
        eventData.completedAt = new Date().toISOString();
        eventData.completedBy = invoker.name();
        eventData.updatedAt = new Date().toISOString();

        // Mark all confirmed attendees as attended
        eventData.attendees.forEach(function(attendee) {
            if (attendee.confirmed) {
                attendee.attended = true;
                attendee.attendedAt = new Date().toISOString();
            }
        });

        // Clear reminders
        clearEventReminders(eventData);

        if (persistenceInitialized) {
            saveData();
        }

        updateChannelDescription();

        invoker.chat('[EventManager] Event completed');

        // Notify attendees
        var channel = eventChannel;
        if (channel) {
            channel.chat('[EventManager] ⚓ Event COMPLETED: ' + eventData.name);
        }
    }

    function handleCloneEvent(templateId, date, time, ev) {
        var invoker = ev.client;

        if (!invokerIsCreator && !invokerIsAdmin) {
            invoker.chat('[EventManager] Permission denied');
            return;
        }

        var template = BUILT_IN_TEMPLATES[templateId];
        if (!template) {
            invoker.chat('[EventManager] Unknown template: ' + templateId);
            return;
        }

        // Create event from template with new date/time
        var eventData = {
            id: Date.now(),
            templateId: templateId,
            name: template.name,
            description: template.description,
            location: template.location,
            goal: template.goal,
            missionNeeds: template.missionNeeds,
            strategy: template.strategy,
            additionalInfo: template.additionalInfo || '',
            date: date,
            time: time,
            duration: defaultEventDuration,
            recurrence: 'none',
            status: 'scheduled',
            reminderMinutes: template.reminderMinutes || [30, 5],
            tags: template.tags || [],
            host: invoker.name(),
            attendees: [],
            remindersSent: [],
            attendeesConfirmed: 0,
            attendeesPending: 0,
            mutedAttendees: [],
            postedBy: invoker.name(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        events.push(eventData);

        if (persistenceInitialized) {
            saveData();
        }

        // Schedule reminders
        scheduleEventReminders(eventData);

        // Update channel description
        updateChannelDescription();

        invoker.chat('[EventManager] Event cloned: ' + eventData.name + ' from ' + templateId + ' to ' + date + ' ' + time);
    }

    function handleRemoveEvent(eventId, ev) {
        var invoker = ev.client;
        var eventIndex = findEventById(eventId);

        if (eventIndex === -1) {
            invoker.chat('[EventManager] Event not found: ' + eventId);
            return;
        }

        var eventData = events[eventIndex];

        // Only admin can remove events
        if (!invokerIsAdmin) {
            invoker.chat('[EventManager] Permission denied — only admin can remove events');
            return;
        }

        // Clear reminders
        clearEventReminders(eventData);

        events.splice(eventIndex, 1);

        if (persistenceInitialized) {
            saveData();
        }

        updateChannelDescription();

        invoker.chat('[EventManager] Event removed: ' + eventId);
    }

    function handleMuteEvent(eventId, ev) {
        var invoker = ev.client;
        var eventIndex = findEventById(eventId);

        if (eventIndex === -1) {
            invoker.chat('[EventManager] Event not found: ' + eventId);
            return;
        }

        var eventData = events[eventIndex];

        for (var i = 0; i < eventData.attendees.length; i++) {
            if (eventData.attendees[i].name === invoker.name()) {
                eventData.attendees[i].muted = true;
                break;
            }
        }

        if (persistenceInitialized) {
            saveData();
        }

        invoker.chat('[EventManager] Muted event reminders: ' + eventData.name);
    }

    function handleUnmuteEvent(eventId, ev) {
        var invoker = ev.client;
        var eventIndex = findEventById(eventId);

        if (eventIndex === -1) {
            invoker.chat('[EventManager] Event not found: ' + eventId);
            return;
        }

        var eventData = events[eventIndex];

        for (var i = 0; i < eventData.attendees.length; i++) {
            if (eventData.attendees[i].name === invoker.name()) {
                eventData.attendees[i].muted = false;
                break;
            }
        }

        if (persistenceInitialized) {
            saveData();
        }

        invoker.chat('[EventManager] Unmuted event reminders: ' + eventData.name);
    }

    // ===== DISPLAY FUNCTIONS =====
    function displayEventList(ev, filter) {
        var invoker = ev.client;
        var filteredEvents = events.slice();

        if (filter === 'active') {
            filteredEvents = filteredEvents.filter(function(e) { return e.status === 'active'; });
        } else if (filter === 'scheduled') {
            filteredEvents = filteredEvents.filter(function(e) { return e.status === 'scheduled'; });
        } else if (filter === 'completed') {
            filteredEvents = filteredEvents.filter(function(e) { return e.status === 'completed'; });
        } else if (filter === 'cancelled') {
            filteredEvents = filteredEvents.filter(function(e) { return e.status === 'cancelled'; });
        } else if (filter === 'upcoming') {
            filteredEvents = filteredEvents.filter(function(e) {
                if (e.status !== 'scheduled') return false;
                var eventTime = new Date(e.date + 'T' + e.time).getTime();
                return eventTime > Date.now();
            });
        }

        if (filteredEvents.length === 0) {
            invoker.chat('[EventManager] No events found');
            return;
        }

        var message = '[EventManager] EVENTS:\n';
        for (var i = 0; i < filteredEvents.length; i++) {
            var event = filteredEvents[i];
            var status = event.status.toUpperCase();
            var attendees = event.attendeesConfirmed + '/' + event.attendees.length;
            var date = formatDate(event.date);
            var time = event.time;

            message += '[' + (i + 1) + '] ' + event.name + ' | ' + date + ' ' + time + ' | ' + attendees + ' | ' + status + '\n';
            message += '   Host: ' + event.host + '\n';
            if (event.attendees.length > 0) {
                message += '   Attendees: ' + event.attendees.map(function(a) { return a.name; }).join(', ') + '\n';
            }
            message += '\n';
        }

        invoker.chat(message);
    }

    function displayEventInfo(eventId, ev) {
        var invoker = ev.client;
        var eventIndex = findEventById(eventId);

        if (eventIndex === -1) {
            invoker.chat('[EventManager] Event not found: ' + eventId);
            return;
        }

        var event = events[eventIndex];
        var message = '[EventManager] EVENT INFO:\n';
        message += 'Name: ' + event.name + '\n';
        message += 'Date: ' + formatDate(event.date) + '\n';
        message += 'Time: ' + event.time + '\n';
        message += 'Host: ' + event.host + '\n';
        message += 'Status: ' + event.status + '\n';
        message += 'Description: ' + event.description + '\n';
        message += 'Location: ' + event.location + '\n';
        message += 'Goal: ' + event.goal + '\n';
        message += 'Attendees: ' + event.attendeesConfirmed + '/' + event.attendees.length + '\n';
        message += 'Tags: ' + event.tags.join(', ') + '\n';
        if (event.recurrence !== 'none') {
            message += 'Recurrence: ' + event.recurrence + '\n';
        }
        message += '\n';
        message += 'Commands: !event sign <id> - sign up, !event info <id> - this info';

        invoker.chat(message);
    }

    function displayEventAttendees(eventId, ev) {
        var invoker = ev.client;
        var eventIndex = findEventById(eventId);

        if (eventIndex === -1) {
            invoker.chat('[EventManager] Event not found: ' + eventId);
            return;
        }

        var event = events[eventIndex];
        var message = '[EventManager] ATTENDEES: ' + event.name + '\n';
        message += 'Confirmed: ' + event.attendeesConfirmed + '\n';
        message += 'Pending: ' + event.attendeesPending + '\n';
        message += '\n';

        for (var i = 0; i < event.attendees.length; i++) {
            var attendee = event.attendees[i];
            var status = attendee.confirmed ? 'CONFIRMED' : 'PENDING';
            var muted = attendee.muted ? 'MUTED' : '';
            message += attendee.name + ' (ship: ' + attendee.shipClass + ') - ' + status + ' ' + muted + '\n';
        }

        invoker.chat(message);
    }

    function displayEventHelp(ev) {
        var invoker = ev.client;
        var p = '!' + botName;

        var helpMsg = '[EventManager] EVENT COMMANDS:\n' +
            p + ' help - Show this help message\n' +
            p + ' list [active|upcoming|completed|cancelled] - List events\n' +
            p + ' info <eventId> - Show event details\n' +
            p + ' sign <eventId> [shipClass] - Sign up for event\n' +
            p + ' signoff <eventId> - Cancel sign-up\n' +
            p + ' attendees <eventId> - Show attendees\n' +
            p + ' create <template|custom> <date> <time> [recurrence] [duration] - Create event\n' +
            p + ' edit <eventId> <field> <value> - Edit event\n' +
            p + ' cancel <eventId> [reason] - Cancel event\n' +
            p + ' complete <eventId> - Complete event\n' +
            p + ' clone <templateId> <date> <time> - Clone template\n' +
            p + ' remove <eventId> - Remove event (admin)\n' +
            p + ' mute <eventId> - Mute reminders\n' +
            p + ' unmute <eventId> - Unmute reminders\n' +
            p + ' servergroups - List server groups\n' +
            p + ' stats [week|month] - Event statistics';

        invoker.chat(helpMsg);
    }

    function listServerGroups(ev) {
        var invoker = ev.client;
        var client = backend.getBotClient();
        if (!client) {
            invoker.chat('[EventManager] Bot not connected');
            return;
        }

        var channelGroups = client.getChannelGroups();
        var serverGroups = client.getServerGroups();

        var message = '[EventManager] SERVER GROUPS:\n';
        message += 'Server Groups:\n';
        for (var i = 0; i < serverGroups.length; i++) {
            var group = serverGroups[i];
            message += group.id() + ': ' + group.name() + '\n';
        }
        message += '\nChannel Groups:\n';
        for (var i = 0; i < channelGroups.length; i++) {
            var group = channelGroups[i];
            message += group.id() + ': ' + group.name() + '\n';
        }

        invoker.chat(message);
    }

    function listMutedEvents(ev) {
        var invoker = ev.client;
        var message = '[EventManager] MUTED EVENTS:\n';
        var hasMuted = false;

        for (var i = 0; i < events.length; i++) {
            var event = events[i];
            for (var j = 0; j < event.attendees.length; j++) {
                var attendee = event.attendees[j];
                if (attendee.name === invoker.name() && attendee.muted) {
                    message += event.name + ' (' + event.date + ' ' + event.time + ')\n';
                    hasMuted = true;
                }
            }
        }

        if (!hasMuted) {
            invoker.chat('[EventManager] No muted events');
            return;
        }

        invoker.chat(message);
    }

    function displayEventStats(filter, ev) {
        var invoker = ev.client;
        var filteredEvents = events.slice();

        if (filter === 'week') {
            var oneWeekAgo = new Date();
            oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
            filteredEvents = filteredEvents.filter(function(e) {
                return new Date(e.createdAt) >= oneWeekAgo;
            });
        } else if (filter === 'month') {
            var oneMonthAgo = new Date();
            oneMonthAgo.setDate(oneMonthAgo.getDate() - 30);
            filteredEvents = filteredEvents.filter(function(e) {
                return new Date(e.createdAt) >= oneMonthAgo;
            });
        }

        var message = '[EventManager] EVENT STATS:\n';
        message += 'Total events: ' + filteredEvents.length + '\n';
        message += 'Scheduled: ' + filteredEvents.filter(function(e) { return e.status === 'scheduled'; }).length + '\n';
        message += 'Active: ' + filteredEvents.filter(function(e) { return e.status === 'active'; }).length + '\n';
        message += 'Completed: ' + filteredEvents.filter(function(e) { return e.status === 'completed'; }).length + '\n';
        message += 'Cancelled: ' + filteredEvents.filter(function(e) { return e.status === 'cancelled'; }).length + '\n';

        var totalAttendees = 0;
        var confirmedAttendees = 0;
        for (var i = 0; i < filteredEvents.length; i++) {
            totalAttendees += filteredEvents[i].attendees.length;
            confirmedAttendees += filteredEvents[i].attendeesConfirmed;
        }
        message += 'Total attendees: ' + totalAttendees + '\n';
        message += 'Confirmed attendees: ' + confirmedAttendees + '\n';
        if (totalAttendees > 0) {
            message += 'Confirmation rate: ' + Math.round((confirmedAttendees / totalAttendees) * 100) + '%' + '\n';
        }

        invoker.chat(message);
    }

    // ===== UTILITY FUNCTIONS =====
    function findEventById(eventId) {
        for (var i = 0; i < events.length; i++) {
            if (events[i].id === parseInt(eventId)) {
                return i;
            }
        }
        return -1;
    }

    function findClientByName(name) {
        var clients = backend.getClients();
        for (var i = 0; i < clients.length; i++) {
            if (containsIgnoreCase(clients[i].name(), name)) {
                return clients[i];
            }
        }
        return null;
    }

    function updateChannelDescription() {
        if (!eventChannel) {
            return;
        }

        var description = '[Events]\n';
        var sortedEvents = events.slice().sort(function(a, b) {
            var timeA = new Date(a.date + 'T' + a.time).getTime();
            var timeB = new Date(b.date + 'T' + b.time).getTime();
            return timeA - timeB;
        });

        var upcomingEvents = sortedEvents.filter(function(e) {
            return e.status === 'scheduled' && new Date(e.date + 'T' + e.time).getTime() > Date.now();
        });

        if (upcomingEvents.length === 0) {
            eventChannel.setDescription('[Events] No upcoming events');
            return;
        }

        for (var i = 0; i < Math.min(upcomingEvents.length, 10); i++) {
            var event = upcomingEvents[i];
            var attendees = event.attendeesConfirmed + '/' + event.attendees.length;
            var date = formatDate(event.date);
            var time = event.time;

            description += '[' + (i + 1) + '] ' + event.name + ' | ' + date + ' ' + time + ' | ' + attendees + '\n';
            description += '   Host: ' + event.host + '\n';
            if (event.attendees.length > 0) {
                description += '   Attendees: ' + event.attendees.map(function(a) { return a.name; }).join(', ') + '\n';
            }
            description += '\n';
        }

        if (upcomingEvents.length > 10) {
            description += '... and ' + (upcomingEvents.length - 10) + ' more events\n';
        }

        description += '\n!event list - View all events\n';
        description += '!event help - Show commands\n';

        eventChannel.setDescription(description);
    }

    function formatDate(dateString) {
        var date = new Date(dateString);
        return date.toLocaleDateString();
    }

    function formatTime(dateString) {
        var date = new Date(dateString);
        return date.toLocaleTimeString();
    }

    function startAutoClear() {
        if (autoClearHours <= 0) {
            return;
        }

        autoClearInterval = setInterval(function() {
            autoClearEvents();
        }, 60000); // Check every minute
    }

    function autoClearEvents() {
        var cleared = 0;
        for (var i = events.length - 1; i >= 0; i--) {
            var event = events[i];
            if (event.status === 'active') {
                var eventTime = new Date(event.date + 'T' + event.time).getTime();
                var clearTime = eventTime + (autoClearHours * 3600000);
                if (Date.now() > clearTime) {
                    event.status = 'completed';
                    event.completedAt = new Date().toISOString();
                    event.completedBy = 'Auto-clear';
                    cleared++;
                }
            }
        }

        if (cleared > 0 && persistenceInitialized) {
            saveData();
            updateChannelDescription();
        }
    }

    function clearEventReminders(event) {
        for (var timerKey in eventReminders) {
            if (timerKey.startsWith(event.id)) {
                clearTimeout(eventReminders[timerKey]);
                delete eventReminders[timerKey];
            }
        }
    }

    function saveData() {
        if (!store) {
            return;
        }

        try {
            store.set('events', JSON.stringify(events));
        } catch (e) {
            logMessage('ERROR saving events: ' + e.message, 1);
        }
    }

    function loadPersistedData() {
        if (!store) {
            return;
        }

        try {
            var storedData = store.get('events');
            if (storedData) {
                events = JSON.parse(storedData);
            }
        } catch (e) {
            logMessage('ERROR loading events: ' + e.message, 1);
            events = [];
        }
    }

    // ===== INITIALIZATION =====
    function scheduleAllEventReminders() {
        for (var i = 0; i < events.length; i++) {
            scheduleEventReminders(events[i]);
        }
    }

    // Start scheduling all reminders
    scheduleAllEventReminders();

});
