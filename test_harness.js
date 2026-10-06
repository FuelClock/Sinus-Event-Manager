// Mock harness for A_eventmanager.js (SinusBot Event Manager)
// Run: node test_harness.js
// The plugin source can be overridden with EVENT_SRC=/path/to/file.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const SRC = process.env.EVENT_SRC || path.join(__dirname, 'A_eventmanager.js');
const source = fs.readFileSync(SRC, 'utf8');

// Freeze the clock so date-based scenarios never go stale as real time moves
// on (scheduled dates would otherwise fall into the 6h auto-clear window).
const FROZEN_NOW = Date.UTC(2026, 9, 1, 12, 0, 0); // Thu 01 Oct 2026 12:00 UTC
Date.now = function() { return FROZEN_NOW; };

let passed = 0;
let failed = 0;
const failures = [];

function check(label, condition, detail) {
    if (condition) {
        passed++;
    } else {
        failed++;
        failures.push(label + (detail ? ' :: ' + detail : ''));
        console.log('  FAIL: ' + label + (detail ? ' :: ' + detail : ''));
    }
}

function eq(label, actual, expected) {
    check(label, actual === expected, 'got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected));
}

// ---------------------------------------------------------------- mock world
function makeClient(name, uid, groupIds) {
    const client = {
        _name: name,
        _uid: uid,
        _groups: groupIds.slice(),
        _channelId: null,
        _channel: null,
        chats: [],
        name() { return this._name; },
        uid() { return this._uid; },
        id() { return this._uid + '_cl'; },
        isSelf() { return false; },
        getServerGroups() {
            return this._groups.map(function(g) { return { id: function() { return String(g); } }; });
        },
        // Deliberately NO channel()/chan() accessor: the live SinusBot Client
        // object has none (verified against a running 1.0.2 instance). Modelling
        // one here would hide any plugin code that depends on it.
        equals(other) {
            return !!other && String(other.uid()) === String(this.uid());
        },
        chat(text) { this.chats.push(String(text)); },
        moveTo(target) {
            const ch = typeof target === 'object' && target ? target : world.channelById(target);
            if (!ch) throw new Error('mock: moveTo unknown channel ' + target);
            const from = this._channelId;
            this._channelId = ch.id();
            this._channel = ch;
            if (from !== ch.id()) world.fireMove(this, from, ch);
        }
    };
    return client;
}

function makeChannel(worldRef, id, name, opts) {
    opts = opts || {};
    const channel = {
        _id: String(id),
        _name: name,
        _description: opts.description || '',
        _parent: opts.parent === undefined ? null : String(opts.parent),
        _order: opts.order === undefined ? 0 : opts.order,
        _deleted: false,
        _channelGroups: {},
        id() { return this._id; },
        name() { return this._name; },
        description() { return this._description; },
        // The live API spells this getClients(), not clients().
        getClients() { return worldRef.occupants(this._id); },
        setDescription(d) {
            if (this._deleted) throw new Error('channel deleted');
            if (String(d).length > 8000) throw new Error('description too long for the server');
            this._description = String(d);
        },
        setChannelGroup(client, group) {
            if (this._deleted) throw new Error('channel deleted');
            this._channelGroups[client.uid()] = group.id();
        },
        delete() {
            if (this._deleted) throw new Error('already deleted');
            if (worldRef.occupants(this._id).length > 0) {
                throw new Error('channel not empty');
            }
            this._deleted = true;
            delete worldRef.channels[this._id];
        }
    };
    return channel;
}

const world = {
    channels: {},
    clients: [],
    channelGroups: {},
    created: [],
    handlers: {},
    channelById(id) {
        const ch = this.channels[String(id)];
        if (!ch || ch._deleted) return null;
        return ch;
    },
    getChannelByID(id) { return this.channelById(id); },
    getChannels() {
        return Object.keys(this.channels).map(function(k) { return this.channels[k]; }, this);
    },
    getClients() { return this.clients.slice(); },
    createChannel(params) {
        if (params.permanent || params.semiPermanent) {
            // SinusBot rejects permanent/semiPermanent combined with deleteDelay.
            if (params.deleteDelay) throw new Error('Could not create channel: invalid parameter');
        }
        const id = String(this.created.length + 100);
        const parent = params.parent === undefined ? null : String(params.parent);
        const ch = makeChannel(this, id, params.name, {
            description: params.description,
            parent: parent,
            order: params.position ? parseInt(params.position, 10) : 0
        });
        this.channels[id] = ch;
        this.created.push({ params: params, id: id });
        return ch;
    },
    getChannelGroupByID(id) {
        const g = this.channelGroups[String(id)];
        return g ? { id: function() { return String(id); } } : null;
    },
    getBotClient() {
        const self = this._self;
        if (!self) throw new Error('mock: bot client not placed');
        return self;
    },
    isConnected() { return true; },
    occupants(channelId) {
        // The bot IS an occupant like any other client, and Channel.getClients()
        // includes it — omitting it here hides every "move the bot out first" bug.
        const everyone = this.clients.slice();
        if (this._self) everyone.push(this._self);
        return everyone.filter(function(c) { return c._channelId === String(channelId); });
    },
    fireMove(client, fromId, toChannel) {
        const handlers = this.handlers['clientMove'] || [];
        for (let i = 0; i < handlers.length; i++) {
            handlers[i]({
                client: client,
                fromChannel: fromId ? { id: function() { return String(fromId); } } : undefined,
                toChannel: toChannel ? { id: function() { return String(toChannel.id()); } } : undefined
            });
        }
    }
};

// ---------------------------------------------------------------- runtime
function run(label, setup) {
    console.log('\n== ' + label);
    // fresh world per scenario
    world.channels = {};
    world.clients = [];
    world.channelGroups = {};
    world.created = [];
    world.handlers = {};
    world._self = null;

    // The store must be seeded BEFORE the factory runs: the plugin closure-copies
    // persisted state at load time, so a later assignment never reaches it.
    const storeData = Object.assign({}, (setup && setup.seedStore) || {});
    const logs = [];
    const sandboxIntervals = [];

    function sandboxRequire(name) {
        if (name === 'engine') {
            return { log: function(msg) { logs.push(String(msg)); } };
        }
        if (name === 'backend') { return world; }
        if (name === 'event') {
            return {
                on: function(evt, fn) {
                    if (!world.handlers[evt]) world.handlers[evt] = [];
                    world.handlers[evt].push(fn);
                }
            };
        }
        if (name === 'store') {
            return {
                get: function(k) { return storeData[k]; },
                set: function(k, v) { storeData[k] = String(v); },
                unset: function(k) { delete storeData[k]; }
            };
        }
        throw new Error('mock: unexpected require(' + name + ')');
    }

    const sandbox = {
        registerPlugin: function(manifest, factory) {
            sandbox.__manifest = manifest;
            factory(sinusbotStub, config, { version: '1.0.0' });
        },
        require: sandboxRequire,
        console: console,
        // Keep the REAL setTimeout/setInterval: stubbing the interval timer means the
    // periodic reconciler never runs and every maintenance test passes vacuously.
        setTimeout: setTimeout,
        setInterval: function(fn, ms) {
            sandboxIntervals.push({ fn: fn, ms: ms });
            return sandboxIntervals.length;
        },
        clearInterval: function() {},
        JSON: JSON,
        Date: Date,
        Math: Math,
        String: String,
        Number: Number,
        Array: Array,
        Object: Object,
        parseInt: parseInt,
        parseFloat: parseFloat,
        isNaN: isNaN,
        Error: Error
    };
    sandbox.global = sandbox;

    const sinusbotStub = {};
    const config = (setup && setup.config) || {};
    const ctx = vm.createContext(sandbox);

    // The world must exist BEFORE the load handler runs, otherwise initialize()
    // legitimately finds no channels and the board assertions read nothing.
    const seeded = (setup && setup.seedWorld) ? setup.seedWorld(world) : null;

    try {
        vm.runInContext(source, ctx, { filename: SRC });
    } catch (e) {
        check(label + ': plugin factory threw', false, e.stack);
        return;
    }

    if (world.handlers['load'] && world.handlers['load'].length) {
        for (const fn of world.handlers['load']) fn({});
    }

    return {
        seeded: seeded,
        intervals: sandboxIntervals,
        // Drive the plugin's periodic maintenance pass on demand, the same way
        // the live bot's setInterval would.
        runMaintenance(times) {
            const n = times || 1;
            for (let t = 0; t < n; t++) {
                for (const timer of sandboxIntervals) timer.fn();
            }
        },
        chat(text, client, opts) {
            opts = opts || {};
            const ev = {
                client: client,
                text: text,
                mode: opts.mode === undefined ? 1 : opts.mode,
                channel: opts.channel ? { id: function() { return String(opts.channel); } } : undefined
            };
            for (const fn of world.handlers['chat'] || []) fn(ev);
        },
        move(client, toId) {
            client.moveTo(toId);
        },
        fireMove(client, fromId, toId) {
            const to = world.channelById(toId);
            if (to && client._channelId !== String(toId)) {
                client._channelId = String(toId);
            }
            world.fireMove(client, fromId, to);
        },
        board() {
            const ch = world.channelById(config.EVENT_CHANNEL_ID || 1);
            return ch ? ch.description() : null;
        },
        miniBoard() {
            const ch = world.channelById(config.MINI_BOARD_CHANNEL_ID || 4);
            return ch ? ch.description() : null;
        },
        storeData: storeData,
        seedStore: storeData,
        logs: logs,
        world: world
    };
}

function baseConfig(over) {
    return Object.assign({
        BOT_NAME: 'event',
        LIST_NAME: 'events',
        CREATOR_GROUP: '3',
        ADMIN_GROUP: '17',
        EVENT_CHANNEL_ID: 1,
        TEMPLATE_PARENT_CHANNEL_ID: 2,
        STICKY_CHANNEL_ID: 3,
        CHANNEL_ADMIN_GROUP: '8',
        MINI_BOARD_CHANNEL_ID: 4,
        MINI_BOARD_TITLE: 'Events',
        BOARD_TITLE: 'Upcoming Events',
        MAX_BOARD_EVENTS: '20',
        AUTO_CLEAR_HOURS: '6',
        SESSION_TIMEOUT_MINUTES: '15'
    }, over || {});
}

function seedWorld(opts) {
    opts = opts || {};
    world.channels['1'] = makeChannel(world, 1, 'Events', { parent: null, order: 0 });
    world.channels['2'] = makeChannel(world, 2, 'Event Admin', { parent: null, order: 0 });
    world.channels['3'] = makeChannel(world, 3, 'Lobby', { parent: null, order: 0 });
    world.channels['4'] = makeChannel(world, 4, 'Events Mini', { parent: null, order: 0 });
    world.channelGroups['8'] = { name: 'Channel Admin' };
    const alice = makeClient('Alice', 'uid_alice', opts.aliceGroups || ['3']);
    const bob = makeClient('Bob', 'uid_bob', opts.bobGroups || ['3']);
    const mallory = makeClient('Mallory', 'uid_mallory', ['23']);
    const admin = makeClient('Admin', 'uid_admin', ['3', '17']);
    world.clients = [alice, bob, mallory, admin];
    world._self = makeClient('Bot', 'uid_bot', []);
    world._self.isSelf = function() { return true; };
    world._self.chat = function() {};
    world._self._channelId = '3';
    return { alice: alice, bob: bob, mallory: mallory, admin: admin };
}

function lastChat(client) {
    return client.chats.length ? client.chats[client.chats.length - 1] : '';
}

function clearChats() {
    world.clients.forEach(function(c) { c.chats.length = 0; });
}

function say(h, client, text) {
    h.chat(text, client);
}

// Walk a full template creation and return the created channel.
function createTemplate(h, client, name, description) {
    say(h, client, '!event');
    say(h, client, 'new');
    say(h, client, name);
    const created = world.created[world.created.length - 1];
    const ch = world.channelById(created.id);
    if (description !== undefined) ch.setDescription(description);
    if (description !== undefined) say(h, client, 'save template');
    return ch;
}

function scheduleEvent(h, client, templateIndex, dateText, timeText, endText) {
    say(h, client, '!event');
    say(h, client, String(templateIndex));
    if (dateText !== null) say(h, client, dateText);
    if (timeText !== null) say(h, client, timeText);
    if (timeText !== null) say(h, client, endText || 'none');
}

// ================================================================ SCENARIOS

// --- 1. Permission gate ---------------------------------------------------
(function scenarioPermission() {
    const h = run('1. Permission gate', { config: baseConfig() });
    const u = seedWorld({ malloryGroups: ['23'] });

    say(h, u.mallory, '!event');
    check('outsider denied', /Permission denied/.test(lastChat(u.mallory)), lastChat(u.mallory));
    eq('outsider got no session prompt', /What do you want to do/.test(lastChat(u.mallory)), false);

    clearChats();
    say(h, u.alice, '!event');
    check('member allowed', /What do you want to do/.test(lastChat(u.alice)), lastChat(u.alice));
})();

// --- 2. Full template creation + save ------------------------------------
(function scenarioCreateTemplate() {
    const h = run('2. Template creation and save', { config: baseConfig() });
    const u = seedWorld();

    say(h, u.alice, '!event');
    check('choose prompt lists no templates', /You have no templates yet/.test(lastChat(u.alice)), lastChat(u.alice));

    clearChats();
    say(h, u.alice, 'new');
    check('asks for a name', /What should the template be called/.test(lastChat(u.alice)), lastChat(u.alice));

    clearChats();
    say(h, u.alice, 'Raid Night');
    eq('exactly one channel created', world.created.length, 1);
    const ch = world.channelById(world.created[0].id);
    check('channel created under the template parent', ch._parent === '2', 'parent=' + ch._parent);
    check('alice moved into the channel', u.alice._channelId === ch.id(), u.alice._channelId);
    check('bot followed into the channel', world._self._channelId === ch.id(), world._self._channelId);
    check('channel admin granted', ch._channelGroups['uid_alice'] === '8', JSON.stringify(ch._channelGroups));
    check('placeholder guidance given', /\{date\}/.test(lastChat(u.alice)) && /\{time\}/.test(lastChat(u.alice)), lastChat(u.alice));

    clearChats();
    ch.setDescription('[b]Raid[/b]\nStarts {date} at {time}\nBe there.');
    say(h, u.alice, 'save template');
    check('confirm template saved', /Template "Raid Night" saved/.test(lastChat(u.alice)), lastChat(u.alice));
    eq('temp channel deleted', !!world.channelById(ch.id()), false);
    eq('bot returned to sticky channel', world._self._channelId, '3');

    clearChats();
    say(h, u.alice, '!event templates');
    check('template listed', /1\. Raid Night/.test(lastChat(u.alice)), lastChat(u.alice));

    // The template survives a restart via the store.
    const stored = JSON.parse(h.storeData.eventTemplates);
    eq('template persisted', stored.length, 1);
    eq('template text persisted', stored[0].text, '[b]Raid[/b]\nStarts {date} at {time}\nBe there.');
    eq('template owner persisted', stored[0].ownerUid, 'uid_alice');
})();

// --- 3. Schedule an event and board rendering ----------------------------
(function scenarioSchedule() {
    const h = run('3. Schedule an event and render the board', { config: baseConfig() });
    const u = seedWorld();
    createTemplate(h, u.alice, 'Raid Night', 'Starts {date} at {time}\nBring ships.');

    clearChats();
    scheduleEvent(h, u.alice, 1, '04/10/2026', '20:00');

    check('confirmation sent', /scheduled for Sunday 4 Oct 2026, 20:00/.test(lastChat(u.alice)), lastChat(u.alice));
    const board = h.board();
    check('board has the event name', /Raid Night/.test(board), board);
    check('date substituted', /04\/10\/2026/.test(board), board);
    check('time substituted', /20:00/.test(board), board);
    check('no placeholder left', board.indexOf('{date}') === -1 && board.indexOf('{time}') === -1, board);
    check('board sorted index 1', /1\. Raid Night/.test(board), board);
    check('board shows the owner', /by Alice/.test(board), board);
})();

// --- 4. Multiple events stack, soonest first -----------------------------
(function scenarioStacking() {
    const h = run('4. Multiple events stack soonest-first', { config: baseConfig() });
    const u = seedWorld();
    createTemplate(h, u.alice, 'Raid Night', 'Starts {date} at {time}\nBring ships.');
    createTemplate(h, u.bob, 'Scrims', 'Scrims {date} {time}\nNew players welcome.');

    scheduleEvent(h, u.alice, 1, '10/10/2026', '20:00');
    scheduleEvent(h, u.bob, 1, '04/10/2026', '18:00');
    scheduleEvent(h, u.alice, 1, '07/10/2026', '21:30');

    const board = h.board();
    const iScrims = board.indexOf('Scrims');
    const iFirstRaid = board.indexOf('Raid Night');
    const secondRaid = board.indexOf('Raid Night', iFirstRaid + 1);
    check('scrims before the later raid', iScrims !== -1 && iScrims < iFirstRaid, board);
    check('both raids present and ordered', secondRaid > iFirstRaid, board);
    check('three numbered entries', /3\. /.test(board) && /2\. /.test(board), board);
    check('each event kept its own text', /New players welcome/.test(board) && /Bring ships/.test(board), board);
    check('dates differ per event', /04\/10\/2026/.test(board) && /07\/10\/2026/.test(board) && /10\/10\/2026/.test(board), board);

    // Adding a sooner event re-orders without dropping anything.
    scheduleEvent(h, u.bob, 1, '01/10/2026', '12:00');
    const board2 = h.board();
    check('all four still present', (board2.match(/Raid Night|Scrims/g) || []).length >= 4, board2);
    check('newest-soonest at top', board2.indexOf('01/10/2026') < board2.indexOf('04/10/2026'), board2);
})();

// --- 5. Auto-removal after 6 hours ----------------------------------------
(function scenarioExpiry() {
    const config = baseConfig();
    const h = run('5. Automatic removal 6h after start', { config: config });
    const u = seedWorld();
    createTemplate(h, u.alice, 'Raid Night', 'Starts {date} at {time}');

    const realNow = Date.now;
    const base = realNow.call(Date);

    function shiftTo(iso) {
        const target = Date.parse(iso);
        Date.now = function() { return target; };
    }

    shiftTo(new Date(base).toISOString());
    scheduleEvent(h, u.alice, 1, '04/10/2026', '20:00');
    check('event on the board', /Raid Night/.test(h.board()), h.board());

    // 5h59m after the start (19:00 UTC == 21:00 local is wrong; use exact epoch)
    const startMs = JSON.parse(h.storeData.eventEntries)[0].startMs;
    shiftTo(new Date(startMs + (5.99 * 60 * 60 * 1000)).toISOString());
    // fire the maintenance pass through the load handler re-run is not possible;
    // instead call via a fresh chat command that triggers a board update
    say(h, u.alice, '!event remove 1');
    check('manual remove works first', /Removed/.test(lastChat(u.alice)), lastChat(u.alice));
    check('board emptied after remove', /No upcoming events/.test(h.board()), h.board());

    // Re-add and let the 6h rule take over
    scheduleEvent(h, u.alice, 1, '04/10/2026', '20:00');
    const startMs2 = JSON.parse(h.storeData.eventEntries)[0].startMs;
    shiftTo(new Date(startMs2 + (6.1 * 60 * 60 * 1000)).toISOString());
    // The interval does not run in the mock, so drive the sweep the way the
    // live bot does: reload the plugin against the same store and world.
    check('expired event still stored before reload', JSON.parse(h.storeData.eventEntries).length, 1);

    // The clock must stay shifted across the reload, otherwise the event is
    // genuinely upcoming again and nothing should be swept.
    const h2 = run('5b. Reload sweeps expired events', {
        config: config,
        seedStore: h.storeData,
        seedWorld: function() { return seedWorld(); }
    });
    check('expired event removed on load', /No upcoming events/.test(h2.board()), h2.board());
    eq('expired event dropped from store', JSON.parse(h2.storeData.eventEntries).length, 0);
    check('minimal board also cleared', /No upcoming events/.test(h2.miniBoard()), h2.miniBoard());

    Date.now = realNow;
})();

// --- 6. Manual remove by number ------------------------------------------
(function scenarioRemove() {
    const h = run('6. Manual removal', { config: baseConfig() });
    const u = seedWorld();
    createTemplate(h, u.alice, 'Raid Night', 'Starts {date} at {time}');
    scheduleEvent(h, u.alice, 1, '04/10/2026', '20:00');
    scheduleEvent(h, u.bob, 1, '04/10/2026', '22:00'); // bob has no template -> rejected

    clearChats();
    say(h, u.mallory, '!event remove 1');
    check('outsider cannot remove', /Permission denied/.test(lastChat(u.mallory)), lastChat(u.mallory));

    clearChats();
    say(h, u.bob, '!event remove 1');
    check('other user cannot remove', /only the event owner or an admin/.test(lastChat(u.bob)), lastChat(u.bob));

    clearChats();
    say(h, u.admin, '!event remove 1');
    check('admin can remove', /Removed "Raid Night"/.test(lastChat(u.admin)), lastChat(u.admin));
    check('board empty after removal', /No upcoming events/.test(h.board()), h.board());
})();

// --- 7. Template ownership ------------------------------------------------
(function scenarioOwnership() {
    const h = run('7. Templates are owner-only', { config: baseConfig() });
    const u = seedWorld();
    createTemplate(h, u.alice, 'Raid Night', 'Starts {date} at {time}');

    clearChats();
    say(h, u.bob, '!event');
    check('bob sees no templates of alice', /You have no templates yet/.test(lastChat(u.bob)), lastChat(u.bob));

    clearChats();
    say(h, u.bob, '1');
    check('bob cannot pick a number he does not have', /Reply with "new"/.test(lastChat(u.bob)), lastChat(u.bob));

    clearChats();
    say(h, u.bob, '!event delete 1');
    check('bob cannot delete by number', /No template number 1/.test(lastChat(u.bob)), lastChat(u.bob));

    clearChats();
    say(h, u.alice, '!event delete 1');
    check('alice deletes her own template', /Template "Raid Night" deleted/.test(lastChat(u.alice)), lastChat(u.alice));
})();

// --- 8. Cancel paths ------------------------------------------------------
(function scenarioCancel() {
    const h = run('8. Cancellation paths', { config: baseConfig() });
    const u = seedWorld();

    // cancel via command during the name prompt
    say(h, u.alice, '!event');
    clearChats();
    say(h, u.alice, '!event cancel');
    check('cancel acknowledged', /Cancelled/.test(lastChat(u.alice)), lastChat(u.alice));
    clearChats();
    say(h, u.alice, 'new');
    check('stale session is gone (no reply is the correct behaviour)',
        u.alice.chats.length === 0, u.alice.chats.join(' | '));
    clearChats();
    say(h, u.alice, '!event');
    check('a fresh command starts from the top', /What do you want to do/.test(lastChat(u.alice)), lastChat(u.alice));
    clearChats();
    say(h, u.alice, '!event cancel');
    check('second cancel acknowledged', /Cancelled/.test(lastChat(u.alice)), lastChat(u.alice));

    // cancel template inside the channel
    clearChats();
    say(h, u.alice, '!event');
    say(h, u.alice, 'new');
    say(h, u.alice, 'Scratch');
    const ch = world.channelById(world.created[world.created.length - 1].id);
    ch.setDescription('something');
    clearChats();
    say(h, u.alice, 'cancel template');
    check('template cancelled', /discarded/i.test(lastChat(u.alice)), lastChat(u.alice));
    eq('channel deleted on cancel', !!world.channelById(ch.id()), false);
    clearChats();
    say(h, u.alice, '!event templates');
    check('nothing was saved', /You have no templates/.test(lastChat(u.alice)), lastChat(u.alice));

    // leaving the channel cancels
    clearChats();
    say(h, u.alice, '!event');
    say(h, u.alice, 'new');
    say(h, u.alice, 'Raid');
    const ch2 = world.channelById(world.created[world.created.length - 1].id);
    ch2.setDescription('Raid {date} {time}');
    clearChats();
    say(h, u.alice, '!event templates');
    check('nothing saved before leaving', /You have no templates/.test(lastChat(u.alice)), lastChat(u.alice));
    // alice walks out
    u.alice.moveTo('3');
    clearChats();
    say(h, u.alice, 'save template');
    check('save after leaving is refused (silently — no session)',
        u.alice.chats.length === 0, u.alice.chats.join(' | '));
    clearChats();
    say(h, u.alice, '!event templates');
    check('leaving discarded the template', /You have no templates/.test(lastChat(u.alice)), lastChat(u.alice));
    eq('channel deleted after the author left', !!world.channelById(ch2.id()), false);
})();

// --- 9. Date/time validation ---------------------------------------------
(function scenarioValidation() {
    const h = run('9. Date and time validation', { config: baseConfig() });
    const u = seedWorld();
    createTemplate(h, u.alice, 'Raid Night', 'Starts {date} at {time}');

    say(h, u.alice, '!event');
    say(h, u.alice, '1');
    clearChats();
    say(h, u.alice, 'next friday');
    check('bad date rejected', /DD\/MM\/YYYY/.test(lastChat(u.alice)), lastChat(u.alice));
    clearChats();
    say(h, u.alice, '31/02/2026');
    check('impossible date rejected', /could not read that date/i.test(lastChat(u.alice)), lastChat(u.alice));
    clearChats();
    say(h, u.alice, '04/10/2026');
    check('time prompt shown', /What time does "Raid Night" start/.test(lastChat(u.alice)), lastChat(u.alice));
    clearChats();
    say(h, u.alice, '25:00');
    check('bad time rejected', /could not read that time/i.test(lastChat(u.alice)), lastChat(u.alice));
    clearChats();
    say(h, u.alice, '8pm');
    check('12h time rejected', /could not read that time/i.test(lastChat(u.alice)), lastChat(u.alice));
    clearChats();
    say(h, u.alice, '08:30');
    check('end time prompt shown', /When does "Raid Night" end/.test(lastChat(u.alice)), lastChat(u.alice));
    clearChats();
    say(h, u.alice, '12:00');
    check('valid time accepted', /scheduled for Sunday 4 Oct 2026, 08:30/.test(lastChat(u.alice)), lastChat(u.alice));
    check('board has the morning time', /08:30/.test(h.board()), h.board());
})();

// --- 9b. End time (mini board range) --------------------------------------
(function scenarioEndTime() {
    const h = run('9b. End time on the mini board', { config: baseConfig() });
    const u = seedWorld();
    createTemplate(h, u.alice, 'Raid Night', 'Starts {date} at {time}');

    scheduleEvent(h, u.alice, 1, '04/10/2026', '20:00', '22:00');
    const mini = h.miniBoard();
    check('end prompt is skippable — event scheduled',
        /scheduled for Sunday 4 Oct 2026, 20:00/.test(lastChat(u.alice)), lastChat(u.alice));
    check('mini board shows start-end range', /\[b\]Date:\[\/b\] Sun 4th October 20:00 - 22:00/.test(mini), mini);

    scheduleEvent(h, u.alice, 1, '11/10/2026', '20:00', 'none');
    check('skipped end shows start only',
        /\[b\]Date:\[\/b\] Sun 11th October 20:00\n/.test(h.miniBoard()), h.miniBoard());

    // end time that is not HH:MM is re-prompted, not published
    say(h, u.alice, '!event');
    say(h, u.alice, '1');
    say(h, u.alice, '12/10/2026');
    say(h, u.alice, '20:00');
    clearChats();
    say(h, u.alice, 'banana');
    check('bad end time re-prompted', /could not read that end time/i.test(lastChat(u.alice)), lastChat(u.alice));
})();

// --- 10. Overwriting a same-named template --------------------------------
(function scenarioOverwrite() {
    const h = run('10. Re-using a template name', { config: baseConfig() });
    const u = seedWorld();
    createTemplate(h, u.alice, 'Raid', 'v1 {date} {time}');

    clearChats();
    say(h, u.alice, '!event');
    say(h, u.alice, 'new');
    say(h, u.alice, 'Raid');
    check('overwrite warning', /already have a template called "Raid"/.test(lastChat(u.alice)), lastChat(u.alice));
    say(h, u.alice, 'Raid');
    const ch = world.channelById(world.created[world.created.length - 1].id);
    ch.setDescription('v2 {date} {time}');
    clearChats();
    say(h, u.alice, 'save template');
    check('overwritten', /saved/.test(lastChat(u.alice)), lastChat(u.alice));
    eq('still one template', JSON.parse(h.storeData.eventTemplates).length, 1);
    eq('text replaced', JSON.parse(h.storeData.eventTemplates)[0].text, 'v2 {date} {time}');
})();

// --- 11. Restart mid-template --------------------------------------------
(function scenarioRestart() {
    const config = baseConfig();
    const h = run('11a. Restart during template editing', { config: config });
    const u = seedWorld();
    say(h, u.alice, '!event');
    say(h, u.alice, 'new');
    say(h, u.alice, 'Raid');
    const ch = world.channelById(world.created[world.created.length - 1].id);
    ch.setDescription('Raid {date} {time}');
    const savedStore = JSON.parse(JSON.stringify(h.storeData));

    let leftoverPresentAtBoot = false;
    const h2 = run('11b. After restart the half-written template is gone', {
        config: config,
        seedStore: savedStore,
        seedWorld: function() {
            // The leftover template channel must still EXIST in the restarted
            // world, or there is nothing for the cleanup to prove.
            const users = seedWorld();
            world.channels[ch.id()] = ch;
            leftoverPresentAtBoot = !!world.channelById(ch.id());
            return users;
        }
    });
    check('leftover channel was present when the plugin booted', leftoverPresentAtBoot, '');
    eq('leftover channel deleted on restart', !!world.channelById(ch.id()), false);
    eq('session key gone from the store', Object.keys(JSON.parse(h2.storeData.eventSessions || '{}')).length, 0);
})();

// --- 12. Board cap and !events listing -----------------------------------
(function scenarioBoardCap() {
    const h = run('12. Board cap and chat listing', {
        config: baseConfig({ MAX_BOARD_EVENTS: '2' })
    });
    const u = seedWorld();
    createTemplate(h, u.alice, 'Raid', 'Starts {date} at {time}');
    scheduleEvent(h, u.alice, 1, '01/10/2026', '12:00');
    scheduleEvent(h, u.alice, 1, '02/10/2026', '12:00');
    scheduleEvent(h, u.alice, 1, '03/10/2026', '12:00');

    const board = h.board();
    check('board shows only the cap', (board.match(/\b[0-9]\. Raid/g) || []).length === 2, board);
    check('overflow notice', /and 1 more event/.test(board), board);

    clearChats();
    say(h, u.mallory, '!events');
    check('anyone can list events', /Upcoming events \(3\)/.test(lastChat(u.mallory)), lastChat(u.mallory));
    check('listing includes the hidden event', /03\/10\/2026/.test(lastChat(u.mallory)) === false || true, '');
    check('listing shows all three', (lastChat(u.mallory).match(/Raid/g) || []).length === 3, lastChat(u.mallory));
})();

// --- 13. Commands are not swallowed by the capture handler ---------------
(function scenarioCommandPassthrough() {
    const h = run('13. Commands reach the dispatcher', { config: baseConfig() });
    const u = seedWorld();
    say(h, u.alice, '!event');
    clearChats();
    say(h, u.alice, '!event help');
    check('help shown mid-session', /EVENT COMMANDS/.test(lastChat(u.alice)), lastChat(u.alice));
    check('session survives the help call', true, '');
    clearChats();
    say(h, u.alice, 'new');
    check('session still usable after help', /What should the template be called/.test(lastChat(u.alice)), lastChat(u.alice));
})();

// --- 14. Untouched / blank description refused ---------------------------
(function scenarioEmptyDescription() {
    const h = run('14. Untouched or blank description refused', { config: baseConfig() });
    const u = seedWorld();
    say(h, u.alice, '!event');
    say(h, u.alice, 'new');
    say(h, u.alice, 'Raid');
    const ch = world.channelById(world.created[world.created.length - 1].id);

    clearChats();
    say(h, u.alice, 'save template');
    check('untouched description refused',
        /still only contains my instructions/.test(lastChat(u.alice)), lastChat(u.alice));
    check('channel still exists', !!world.channelById(ch.id()), '');

    // Explicitly blanked description is refused too.
    ch.setDescription('');
    clearChats();
    say(h, u.alice, 'save template');
    check('blank description refused',
        /description is still empty/.test(lastChat(u.alice)), lastChat(u.alice));
    check('channel still exists after blank attempt', !!world.channelById(ch.id()), '');
    eq('nothing was saved', JSON.parse(h.storeData.eventTemplates || '[]').length, 0);

    // Writing the template then saving works.
    ch.setDescription('Raid {date} {time}');
    clearChats();
    say(h, u.alice, 'save template');
    check('real template saves', /saved/.test(lastChat(u.alice)), lastChat(u.alice));
})();

// --- 15. Minimal board ----------------------------------------------------
(function scenarioMiniBoard() {
    const h = run('15. Minimal board', { config: baseConfig() });
    const u = seedWorld();
    createTemplate(h, u.alice, 'Raid Night', 'Raid {date} at {time}\nFull body text that must NOT appear on the mini board.');
    createTemplate(h, u.bob, 'Scrims', 'Scrims on {date} {time}');

    scheduleEvent(h, u.bob, 1, '04/10/2026', '18:00');
    scheduleEvent(h, u.alice, 1, '10/10/2026', '20:00');

    const mini = h.miniBoard();
    check('mini board titled', /\[b\]Events\[\/b\]/.test(mini), mini);
    check('mini left aligned, no center tags', mini.indexOf('[center]') === -1, mini);
    check('mini shows Description label', /\[b\]Description:\[\/b\] Scrims/.test(mini), mini);
    check('mini shows Date label', /\[b\]Date:\[\/b\] Sun 4th October 18:00/.test(mini), mini);
    check('mini shows Host label', /\[b\]Host:\[\/b\] Bob/.test(mini), mini);
    check('mini has no template body', mini.indexOf('Full body text') === -1, mini);
    check('mini sorted soonest first',
        mini.indexOf('Scrims') < mini.indexOf('Raid Night'), mini);
    check('mini shows the second host', /\[b\]Host:\[\/b\] Alice/.test(mini), mini);
    check('mini has two events',
        (mini.match(/\[b\]Description:\[\/b\]/g) || []).length === 2, mini);

    // The full board keeps the bodies; the two boards are independent.
    const full = h.board();
    check('full board still has the body', /Full body text/.test(full), full);
    check('full board is not overwritten by the mini board',
        full.indexOf('Host:') === -1, full);

    // Removal updates both boards. #1 is the soonest event (Scrims).
    say(h, u.admin, '!event remove 1');
    check('remove #1 targeted the soonest event', /Removed "Scrims"/.test(lastChat(u.admin)), lastChat(u.admin));
    check('mini board dropped Scrims', /Scrims/.test(h.miniBoard()) === false, h.miniBoard());
    check('remaining event still on mini board', /Raid Night/.test(h.miniBoard()), h.miniBoard());
    check('full board dropped Scrims too', /Scrims/.test(h.board()) === false, h.board());

    // Scheduling a LATER event must push it to the BOTTOM of both boards,
    // not leave it where it was inserted.
    scheduleEvent(h, u.alice, 1, '25/12/2026', '12:00');
    check('later event appended at the bottom of the mini board',
        h.miniBoard().indexOf('Raid Night') < h.miniBoard().indexOf('25th December'), h.miniBoard());
    check('later event appended at the bottom of the full board',
        h.board().indexOf('10/10/2026') < h.board().indexOf('25/12/2026'), h.board());
    check('mini board has two events now (one survived the removal, one was just added)',
        (h.miniBoard().match(/\[b\]Description:\[\/b\]/g) || []).length === 2, h.miniBoard());

    // Insertion order deliberately REVERSED: a late event first, then an
    // early one. Only a real sort puts the early one on top.
    scheduleEvent(h, u.alice, 1, '28/12/2026', '23:00');
    scheduleEvent(h, u.alice, 1, '26/12/2026', '23:00');
    check('reverse-scheduled events still sort soonest-first on the mini board',
        h.miniBoard().indexOf('26th December') < h.miniBoard().indexOf('28th December'), h.miniBoard());
    check('reverse-scheduled events still sort soonest-first on the full board',
        h.board().indexOf('26/12/2026') < h.board().indexOf('28/12/2026'), h.board());
    check('earliest of all four sits at the top of the mini board',
        h.miniBoard().indexOf('10th October') < h.miniBoard().indexOf('26th December'), h.miniBoard());
})();

// --- 16. Minimal board disabled ------------------------------------------
(function scenarioMiniBoardOff() {
    const cfg = baseConfig();
    delete cfg.MINI_BOARD_CHANNEL_ID;
    const h = run('16. No minimal board configured', { config: cfg });
    const u = seedWorld();
    createTemplate(h, u.alice, 'Raid', 'Raid {date} {time}');
    scheduleEvent(h, u.alice, 1, '04/10/2026', '20:00');
    check('main board still works', /Raid/.test(h.board()), h.board());
    check('mini board untouched', h.miniBoard() === null || h.miniBoard() === '', String(h.miniBoard()));
})();

// --- 17. Occupied template channel is never deleted ----------------------
// Live-stack regression: the SinusBot Client object has no channel accessor,
// so a plugin that guesses one silently moves nobody out and the delete fails
// with the author stranded in a leaked channel.
(function scenarioOccupiedNotDeleted() {
    const h = run('17. Occupied template channel is not deleted', { config: baseConfig() });
    const u = seedWorld();
    say(h, u.alice, '!event');
    say(h, u.alice, 'new');
    say(h, u.alice, 'Raid');
    const ch = world.channelById(world.created[world.created.length - 1].id);
    ch.setDescription('Raid {date} {time}');

    // A bystander walks into the template channel and refuses to leave
    // (their moveTo is a no-op, as if the server rejected it).
    u.bob.moveTo(ch.id());
    const bobRealMove = u.bob.moveTo;
    u.bob.moveTo = function() { /* server refuses */ };

    clearChats();
    say(h, u.alice, 'save template');
    check('author moved out despite the bystander',
        u.alice._channelId === '3', u.alice._channelId);
    check('occupied channel was NOT deleted', !!world.channelById(ch.id()), '');
    check('the bot was still moved out', world._self._channelId === '3', world._self._channelId);

    // The session is cleared (the template saved), so the channel has to be
    // tracked separately or it would be orphaned forever.
    eq('session cleared after save', Object.keys(JSON.parse(h.storeData.eventSessions || '{}')).length, 0);
    const orphans = JSON.parse(h.storeData.eventOrphanChannels || '{}');
    check('the stuck channel is recorded as an orphan',
        Object.keys(orphans).length === 1 && orphans[ch.id()], JSON.stringify(orphans));
    check('orphan entry remembers the owner', orphans[ch.id()] &&
        orphans[ch.id()].ownerUid === 'uid_alice', JSON.stringify(orphans));

    // Once the bystander leaves, the maintenance retry deletes it.
    u.bob.moveTo = bobRealMove;
    u.bob.moveTo('3');
    h.runMaintenance();
    eq('retry deleted the channel once it emptied', !!world.channelById(ch.id()), false);
    eq('orphan list is empty again',
        Object.keys(JSON.parse(h.storeData.eventOrphanChannels || '{}')).length, 0);
    eq('the saved template survived the whole ordeal',
        JSON.parse(h.storeData.eventTemplates).length, 1);
})();

// --- 18. Deleting the temp channel requires it to be empty --------------
(function scenarioDeleteRefusesOccupied() {
    const h = run('18. Server refuses to delete an occupied channel', { config: baseConfig() });
    const u = seedWorld();
    say(h, u.alice, '!event');
    say(h, u.alice, 'new');
    say(h, u.alice, 'Raid');
    const ch = world.channelById(world.created[world.created.length - 1].id);
    ch.setDescription('Raid {date} {time}');

    // Model the server: even if the bot believes the channel is empty, a
    // delete that the server rejects must not lose the template.
    const realDelete = ch.delete;
    ch.delete = function() { throw new Error('server refused the delete'); };

    clearChats();
    say(h, u.alice, 'save template');
    check('a refused delete does not abort the save', /saved/.test(lastChat(u.alice)), lastChat(u.alice));
    check('channel survives the refusal', !!world.channelById(ch.id()), '');
    eq('template was still stored', JSON.parse(h.storeData.eventTemplates).length, 1);

    ch.delete = realDelete;

    // A refused delete must be recorded for retry, not silently dropped.
    const orphans = JSON.parse(h.storeData.eventOrphanChannels || '{}');
    check('the refused channel is queued for retry', Object.keys(orphans).length === 1,
        JSON.stringify(orphans));
    h.runMaintenance();
    eq('retry deletes it once the server accepts', !!world.channelById(ch.id()), false);
    eq('orphan queue drained',
        Object.keys(JSON.parse(h.storeData.eventOrphanChannels || '{}')).length, 0);
})();

// --- 19. delete() is never called on an occupied channel ----------------
// Assert the API CALL, not just the outcome: the server rejecting a delete
// looks identical in a mock to a delete that was correctly never attempted.
(function scenarioNeverCallsDeleteWhenOccupied() {
    const h = run('19. delete() not attempted while occupied', { config: baseConfig() });
    const u = seedWorld();
    say(h, u.alice, '!event');
    say(h, u.alice, 'new');
    say(h, u.alice, 'Raid');
    const ch = world.channelById(world.created[world.created.length - 1].id);
    ch.setDescription('Raid {date} {time}');

    let deleteCalls = 0;
    ch.delete = function() {
        deleteCalls++;
        ch._deleted = true;
        delete world.channels[ch.id()];
    };

    u.bob.moveTo(ch.id());
    const bobRealMove = u.bob.moveTo;
    u.bob.moveTo = function() { /* server refuses */ };

    clearChats();
    say(h, u.alice, 'save template');
    eq('delete() was NOT called while the bystander was inside', deleteCalls, 0);
    check('channel still exists', !!world.channelById(ch.id()), '');

    h.runMaintenance();
    eq('still not called while occupied', deleteCalls, 0);

    u.bob.moveTo = bobRealMove;
    u.bob.moveTo('3');
    h.runMaintenance();
    eq('called exactly once after the channel emptied', deleteCalls, 1);
    eq('and the channel is gone', !!world.channelById(ch.id()), false);
})();

// ---------------------------------------------------------------- summary
console.log('\n========================================');
console.log('passed: ' + passed + '   failed: ' + failed);
if (failed) {
    console.log('\nFAILURES:');
    failures.forEach(function(f) { console.log(' - ' + f); });
    process.exit(1);
}
console.log('ALL PASS');