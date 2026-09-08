/*-------------------------------------------------------------------

    ___________    ____   _____ _____    ____
    \____ \__  \ _/ ___\ /     \\__  \  /    \
    |  |_> > __ \\  \___|  Y Y  \/ __ \|   |  \
    |   __(____  /\___  >__|_|  (____  /___|  /
    |__|       \/     \/      \/     \/     \/

    author: platzh1rsch        (www.platzh1rsch.ch)
            Ivan Font          (ivanfont.com)

-------------------------------------------------------------------*/

"use strict";

// global constants ported from upstream platzhersh/pacman-canvas v1.0.2 / v1.0.5
// FINAL_LEVEL is the *fallback* used until /config is fetched. The runtime value
// lives on `game.maxLevel` and may be a positive integer or the string 'unlimited'.
const FINAL_LEVEL = 10;
const PILL_POINTS = 10;
const POWERPILL_POINTS = 50;
const GHOST_POINTS = 100;
const HIGHSCORE_ENABLED = true;
const MAX_LEVEL_STORAGE_KEY = 'pacman.maxLevel';
const EBEE_MODE_STORAGE_KEY = 'pacman.ebeeMode';
const CILIUM_LOGO_SRC = 'img/cilium-light.svg';
const KUBERNETES_LOGO_SRC = 'img/kubernetes.svg';

function geronimo() {
/* ----- Global Variables ---------------------------------------- */
    var canvas;
    var joystick;
    var context;
    var game;
    var canvas_walls, context_walls;
    var inky, blinky, clyde, pinky;

    var mapConfig = "data/map.json";
    var highscorePage = 1;
    var highscoreTotalPages = 1;
    var livestatsPage = 1;
    var livestatsTotalPages = 1;

    function escapeHtml(value) {
        return $('<div>').text(value === undefined || value === null ? '' : value).html();
    }

    function renderPagination(selector, page, totalPages) {
        var root = $(selector);
        root.find('[data-page-action="previous"]').prop('disabled', page <= 1);
        root.find('[data-page-action="next"]').prop('disabled', page >= totalPages);
        root.find('.page-label').text('Page ' + page + ' of ' + totalPages);
    }


    function vibrate() {
        if ('vibrate' in navigator) {
            window.navigator.vibrate(200);
        }
    }

    /* AJAX stuff */
    function getHighscore(page) {
        highscorePage = page || 1;
        setTimeout(function () { ajax_get(highscorePage); }, 30);
    }

    function ajax_get(page) {
        $.ajax({
           datatype: "json",
           type: "GET",
              url: "highscores/list?page=" + page + "&pageSize=10&includeSimulated=" + game.showSimulatedUsers,
           success: function(msg){
                 var rows = Array.isArray(msg) ? msg : (msg.items || []);
                 highscorePage = msg.page || page;
                 highscoreTotalPages = msg.totalPages || 1;
             $("#highscore-table tbody").text("");
                 for (var i = 0; i < rows.length; i++) {
                     var rank = (highscorePage - 1) * 10 + i + 1;
                     $("#highscore-table tbody").append("<tr><td>" + rank + "</td><td>" + escapeHtml(rows[i]['name']) + "</td><td>" + escapeHtml(rows[i]['cloud']) + "</td><td>" + escapeHtml(rows[i]['zone']) + "</td><td>" + escapeHtml(rows[i]['host']) + "</td><td>" + escapeHtml(rows[i]['score']) + "</td></tr>");
             }
                 renderPagination('#highscore-pagination', highscorePage, highscoreTotalPages);
           }
        });
    }

    function getLiveStats(page) {
        livestatsPage = page || 1;
        setTimeout(function () { ajaxGetLiveStats(livestatsPage); }, 30);
    }

    function ajaxGetLiveStats(page) {
        $.ajax({
            datatype: "json",
            type: "GET",
            url: "user/stats?page=" + page + "&pageSize=" + game.liveStatsPageSize + "&includeSimulated=" + game.showSimulatedUsers,
            success: function(msg) {
                var rows = Array.isArray(msg) ? msg : (msg.items || []);
                livestatsPage = msg.page || page;
                livestatsTotalPages = msg.totalPages || 1;
                $("#livestats-table tbody").text("");
                for (var i = 0; i < rows.length; i++) {
                    $("#livestats-table tbody").append("<tr><td>" + ((livestatsPage - 1) * game.liveStatsPageSize + i + 1) + "</td><td>" + escapeHtml(rows[i]['name']) + "</td><td>" + escapeHtml(rows[i]['cloud']) + "</td><td>" + escapeHtml(rows[i]['zone']) + "</td><td>" + escapeHtml(rows[i]['host']) + "</td><td>" + escapeHtml(rows[i]['score']) + "</td><td>" + escapeHtml(rows[i]['level']) + "</td><td>" + escapeHtml(rows[i]['lives']) + "</td><td>" + escapeHtml(rows[i]['et']) + "</td><td>" + escapeHtml(rows[i]['txncount']) + "</td></tr>");
                }
                renderPagination('#livestats-pagination', livestatsPage, livestatsTotalPages);

                if (game.user.livestats) {
                    // Schedule ourselves again while user is viewing livestats
                    setTimeout(function () { ajaxGetLiveStats(livestatsPage); }, game.databaseUpdateInterval * 1000);
                }
            }
        });
    }

    function ajaxAdd(n, c, z, h, s, l) {

        $.ajax({
           type: 'POST',
           url: 'highscores',
           data: {
             name: n,
             cloud: c,
             zone: z,
             host: h,
             score: s,
             level: l
             },
           dataType: 'json',
           success: function(data) {
                console.log('Highscore added: ' + data);
                $('#highscore-form').html('<span class="button" id="show-highscore">View Highscore List</span>');
            },
            error: function(xhr) {
                var msg = 'The server rejected this score.';
                try {
                    var body = xhr.responseJSON || JSON.parse(xhr.responseText);
                    if (body && body.error) msg = 'The server rejected this score: ' + body.error + '.';
                } catch (e) { /* keep default */ }
                if (game.serverMaxLevel !== 'unlimited' && game.level > game.serverMaxLevel) {
                    msg += ' You are playing beyond the server max level, so this run is local play only.';
                }
                console.log(xhr);
                $('#highscore-form').html('<div id="server-score-rejected">' + msg + '<br><span class="button" id="show-highscore">View Highscore List</span></div>');
            }
        });
    }

    function ajaxGetCloudMetadata() {
        $.ajax({
            datatype: "json",
            type: "GET",
            url: "location/metadata",
            timeout: 30000, // wait no more than 30 seconds
            success: function(msg){
                $(".cloudprovider").append("<b>" + msg['cloud'] + "</b>");
                game.cloudProvider = msg['cloud'];
                $(".zone").append("<b>" + msg['zone'] + "</b>");
                game.zone = msg['zone'];
                $(".host").append("<b>" + msg['host'] + "</b>");
                game.host = msg['host'];
                updateKubernetesUsageInfo();
            },
            error: function() {
                $(".cloudprovider").append("<b>unknown</b>");
                game.cloudProvider = 'unknown';
                $(".zone").append("<b>unknown</b>");
                game.zone = 'unknown';
                $(".host").append("<b>unknown</b>");
                game.host = 'unknown';
                updateKubernetesUsageInfo();
            }
        });
    }

    function updateKubernetesUsageInfo() {
        var hasCloud = game.cloudProvider && game.cloudProvider !== 'unknown';
        var hasZone = game.zone && game.zone !== 'unknown';
        $('#kubernetes-usage-info').toggle(!!(hasCloud && hasZone));
    }

    function ajaxGetUserId(name) {
        $.ajax({
            datatype: "json",
            type: "GET",
            url: "user/id?name=" + encodeURIComponent(name || ''),
            success: function(msg){
                game.user.id = msg;
            }
        });
    }

    function ajaxUpdateUserStats(u, n, c, z, h, s, le, li, et) {
        $.ajax({
            type: "POST",
            datatype: "json",
            url: "user/stats",
            data: {
                userId: u,
                name: n,
                cloud: c,
                zone: z,
                host: h,
                score: s,
                level: le,
                lives: li,
                elapsedTime: et
            },
            success: function() {
                console.log('Successfully updated user stats');
            },
            error: function(errorThrown) {
                console.log(errorThrown);
            }
        });
    }

    function addHighscore() {
        var name = $("#playerName").val();
        $("#highscore-form").html("Saving highscore...");
        ajaxAdd(name, game.cloudProvider, game.zone, game.host,
                 game.score.score, game.level);
    }

    function getUserId(name) {
        setTimeout(function () { ajaxGetUserId(name); }, 30);
    }

    function getCloudMetadata() {
        setTimeout(ajaxGetCloudMetadata, 30);
    }

    /* ---------- Server / user configuration ----------------------------- */

    // Read the user's max-level override from localStorage, if any.
    // Returns a positive integer, the string 'unlimited', or null when unset.
    function readUserMaxLevelOverride() {
        try {
            var raw = window.localStorage && window.localStorage.getItem(MAX_LEVEL_STORAGE_KEY);
            if (raw === null || raw === undefined || raw === '') return null;
            if (raw === 'unlimited') return 'unlimited';
            var n = parseInt(raw, 10);
            return (Number.isInteger(n) && n >= 1) ? n : null;
        } catch (e) {
            return null;
        }
    }

    function writeUserMaxLevelOverride(value) {
        try {
            if (value === null || value === undefined) {
                window.localStorage.removeItem(MAX_LEVEL_STORAGE_KEY);
            } else {
                window.localStorage.setItem(MAX_LEVEL_STORAGE_KEY, String(value));
            }
        } catch (e) {
            console.warn('localStorage unavailable, settings will not persist', e);
        }
    }

    function readEbeeModeOverride() {
        try {
            var raw = window.localStorage && window.localStorage.getItem(EBEE_MODE_STORAGE_KEY);
            if (raw === 'true') return true;
            if (raw === 'false') return false;
            return null;
        } catch (e) {
            return null;
        }
    }

    function writeEbeeMode(enabled) {
        try {
            window.localStorage.setItem(EBEE_MODE_STORAGE_KEY, enabled ? 'true' : 'false');
        } catch (e) {
            console.warn('localStorage unavailable, eBee mode will not persist', e);
        }
    }

    function applyEbeeMode() {
        var override = game.allowEbeeModeOverride ? readEbeeModeOverride() : null;
        game.ebeeMode = override === null ? game.serverEbeeMode : override;
        renderThemeCopy();
        if (typeof game.drawHearts === 'function' && typeof pacman !== 'undefined' && pacman.lives !== undefined) {
            game.drawHearts(pacman.lives);
        }
    }

    function renderThemeCopy() {
        if (game.ebeeMode) {
            $('#powerpill-instructions').text('In every level there are 4 Cilium power pills, shown with the Cilium logo. If eBee collects one, the flowers turn blue and can be picked for 100 points while the effect lasts. One Cilium power pill results in 50 points.');
            $('#ghost-instructions').text('Picking a blue flower results in 100 points. Its returning eyes travel back to the flower house before it starts chasing eBee again.');
        } else {
            $('#powerpill-instructions').text('In every level there are 4 powerpills, which are a bit bigger than the regular ones. If Pac-Man eats those, he will get strong enough to eat the ghosts. You can see this indicated by the ghosts turning blue. One powerpill results in 50 points.');
            $('#ghost-instructions').text('Eating a ghost results in 100 points. The soul of the ghost will return to the ghost house before starting to chase Pac-Man again.');
        }
    }

    // Recompute game.maxLevel from server default + user override.
    // When the server forbids overrides we ignore any value still sitting in
    // localStorage from a previous, more permissive deployment.
    function applyMaxLevel() {
        var override = game.allowClientOverride ? readUserMaxLevelOverride() : null;
        game.maxLevel = (override !== null) ? override : game.serverMaxLevel;
        console.log('applyMaxLevel:', { server: game.serverMaxLevel, override: override, effective: game.maxLevel, allowOverride: game.allowClientOverride });
    }

    // Fetch the server's gameplay config (currently just maxLevel) and apply it.
    function fetchServerConfig() {
        $.ajax({
            datatype: 'json',
            type: 'GET',
            url: 'config',
            success: function (msg) {
                if (msg && (typeof msg.maxLevel === 'number' || msg.maxLevel === 'unlimited')) {
                    game.serverMaxLevel = msg.maxLevel;
                }
                if (msg && typeof msg.allowClientOverride === 'boolean') {
                    game.allowClientOverride = msg.allowClientOverride;
                }
                if (msg && typeof msg.ebeeMode === 'boolean') {
                    game.serverEbeeMode = msg.ebeeMode;
                }
                if (msg && typeof msg.allowEbeeModeOverride === 'boolean') {
                    game.allowEbeeModeOverride = msg.allowEbeeModeOverride;
                }
                if (msg && msg.appRole) game.appRole = msg.appRole;
                if (msg && msg.appVersion) game.appVersion = msg.appVersion;
                if (msg && msg.appVariant) game.appVariant = msg.appVariant;
                if (msg && msg.appColor) game.appColor = msg.appColor;
                if (msg && Number.isInteger(msg.liveStatsPageSize) && msg.liveStatsPageSize > 0) {
                    game.liveStatsPageSize = msg.liveStatsPageSize;
                }
                if (msg && typeof msg.simulatedUsersEnabled === 'boolean') {
                    game.showSimulatedUsers = msg.simulatedUsersEnabled;
                    $('#highscore-show-simulated, #livestats-show-simulated').prop('checked', game.showSimulatedUsers);
                }
                applyEbeeMode();
                applyMaxLevel();
                if ($('#settings-content').is(':visible')) {
                    renderSettingsForm();
                }
            },
            error: function (err) {
                console.warn('failed to fetch /config, using fallback maxLevel', err);
            }
        });
    }

    // Populate the Settings form with current values when the panel is shown.
    function renderSettingsForm() {
        var server = game.serverMaxLevel;
        var override = readUserMaxLevelOverride();
        $('#server-max-level').text(server === 'unlimited' ? 'unlimited' : server);

        // Lock only gameplay config controls when the server forbids client overrides.
        // Cosmetic options like eBee mode remain local-only and editable.
        var locked = !game.allowClientOverride;
        var ebeeLocked = !game.allowEbeeModeOverride;
        $('#settings-locked-notice').toggle(locked);
        $('.server-config-control').prop('disabled', locked);
        $('#ebeeMode').prop('disabled', ebeeLocked);
        $('#ebee-mode-locked-notice').toggle(ebeeLocked);
        $('#max-level-lock-badge').toggle(locked);
        $('#ebee-mode-lock-badge').toggle(ebeeLocked);

        var mode, custom;
        if (override === null || locked) {
            mode = 'server';
            custom = (typeof server === 'number') ? server : 10;
        } else if (override === 'unlimited') {
            mode = 'unlimited';
            custom = 10;
        } else {
            mode = 'custom';
            custom = override;
        }
        $('input[name="maxLevelMode"][value="' + mode + '"]').prop('checked', true);
        $('#maxLevelCustom').val(custom);
        $('#ebeeMode').prop('checked', game.ebeeMode);
        $('#server-config-json').text(JSON.stringify({
            maxLevel: game.serverMaxLevel,
            allowClientOverride: game.allowClientOverride,
            ebeeMode: game.serverEbeeMode,
            allowEbeeModeOverride: game.allowEbeeModeOverride,
            effectiveMaxLevel: game.maxLevel,
            effectiveEbeeMode: game.ebeeMode,
            appRole: game.appRole,
            appVersion: game.appVersion,
            appVariant: game.appVariant
        }, null, 2));
        $('#settings-status').text('');
    }

    function drawBlock(context, x, y, w, h, color) {
        context.fillStyle = color;
        context.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
    }

    function drawEbee(context, bee) {
        var unit = bee.radius / 8;
        var centerX = bee.posX + bee.radius;
        var centerY = bee.posY + bee.radius;
        var facing = bee.dirX < 0 ? -1 : 1;
        var wingBeat = bee.mouth > 0 ? -1 : 1;
        var bob = (bee.beastModeTimer % 8 < 4) ? -unit : 0;

        context.save();
        context.translate(centerX, centerY + bob);
        if (bee.dirY === -1) context.rotate(-Math.PI / 2);
        else if (bee.dirY === 1) context.rotate(Math.PI / 2);
        else if (facing === -1) context.scale(-1, 1);

        // Wings flap instead of Pac-Man's mouth opening and closing.
        drawBlock(context, -7 * unit, (-6 + wingBeat) * unit, 4 * unit, 3 * unit, '#bff3ff');
        drawBlock(context, -7 * unit, (3 - wingBeat) * unit, 4 * unit, 3 * unit, '#bff3ff');
        drawBlock(context, -6 * unit, (-5 + wingBeat) * unit, 2 * unit, unit, '#ffffff');
        drawBlock(context, -6 * unit, (4 - wingBeat) * unit, 2 * unit, unit, '#ffffff');

        // 8-bit eBee body, inspired by the eBeeDex 8-bit CTF bee but without the flag.
        drawBlock(context, -5 * unit, -5 * unit, 9 * unit, 10 * unit, '#f6c915');
        drawBlock(context, -3 * unit, -5 * unit, 2 * unit, 10 * unit, '#161616');
        drawBlock(context, unit, -5 * unit, 2 * unit, 10 * unit, '#161616');
        drawBlock(context, 4 * unit, -3 * unit, 2 * unit, 6 * unit, '#f6c915');
        drawBlock(context, 5 * unit, -2 * unit, unit, 4 * unit, '#161616');
        drawBlock(context, -6 * unit, -4 * unit, unit, 8 * unit, '#161616');

        // Face, eye, antennae, and a tiny Cilium-blue pixel accent.
        drawBlock(context, 5 * unit, -5 * unit, 2 * unit, 2 * unit, '#f6c915');
        drawBlock(context, 6 * unit, -4 * unit, unit, unit, '#161616');
        drawBlock(context, 4 * unit, -7 * unit, unit, 2 * unit, '#161616');
        drawBlock(context, 6 * unit, -7 * unit, unit, 2 * unit, '#161616');
        drawBlock(context, 3 * unit, 3 * unit, unit, unit, '#00a6d6');
        context.restore();
    }

    function drawFlower(context, ghost) {
        var unit = ghost.radius / 7;
        var centerX = ghost.posX + ghost.radius;
        var centerY = ghost.posY + ghost.radius;

        if (ghost.dead) {
            context.save();
            // Eaten flowers collapse into a small pair of returning eyes,
            // matching the original dead-ghost behaviour visually.
            drawBlock(context, centerX - 5 * unit, centerY - 2 * unit, 4 * unit, 4 * unit, '#ffffff');
            drawBlock(context, centerX + unit, centerY - 2 * unit, 4 * unit, 4 * unit, '#ffffff');
            drawBlock(context, centerX - 3 * unit, centerY - unit, unit, 2 * unit, '#326ce5');
            drawBlock(context, centerX + 3 * unit, centerY - unit, unit, 2 * unit, '#326ce5');
            drawBlock(context, centerX - unit, centerY + 3 * unit, 2 * unit, 3 * unit, '#7bd88f');
            context.restore();
            return;
        }

        var colors = {
            blinky: '#ff4d6d',
            pinky: '#ff8bd1',
            inky: '#40d6ff',
            clyde: '#ffb347'
        };
        var normalPetal = colors[ghost.name] || '#ff8bd1';
        var flickerToNormal = ghost.dazzled && pacman.beastModeTimer < 50 && pacman.beastModeTimer % 8 > 1;
        var petal = (ghost.dazzled && !flickerToNormal) ? '#2f80ff' : normalPetal;
        var center = (ghost.dazzled && !flickerToNormal) ? '#4a90e2' : '#ffea00';
        var stem = '#36b24a';

        context.save();
        drawBlock(context, centerX - unit, centerY + 3 * unit, 2 * unit, 5 * unit, stem);
        drawBlock(context, centerX - 4 * unit, centerY + 5 * unit, 3 * unit, 2 * unit, stem);
        drawBlock(context, centerX + unit, centerY + 4 * unit, 3 * unit, 2 * unit, stem);

        drawBlock(context, centerX - 2 * unit, centerY - 7 * unit, 4 * unit, 4 * unit, petal);
        drawBlock(context, centerX - 7 * unit, centerY - 2 * unit, 4 * unit, 4 * unit, petal);
        drawBlock(context, centerX + 3 * unit, centerY - 2 * unit, 4 * unit, 4 * unit, petal);
        drawBlock(context, centerX - 2 * unit, centerY + 3 * unit, 4 * unit, 4 * unit, petal);
        drawBlock(context, centerX - 4 * unit, centerY - 4 * unit, 3 * unit, 3 * unit, petal);
        drawBlock(context, centerX + unit, centerY - 4 * unit, 3 * unit, 3 * unit, petal);
        drawBlock(context, centerX - 4 * unit, centerY + unit, 3 * unit, 3 * unit, petal);
        drawBlock(context, centerX + unit, centerY + unit, 3 * unit, 3 * unit, petal);

        drawBlock(context, centerX - 2 * unit, centerY - 2 * unit, 4 * unit, 4 * unit, center);
        drawBlock(context, centerX - unit, centerY - unit, unit, unit, '#161616');
        drawBlock(context, centerX + unit, centerY - unit, unit, unit, '#161616');
        context.restore();
    }

    function drawCiliumPill(context, centerX, centerY, size) {
        context.drawImage(game.ciliumLogo, centerX - size / 2, centerY - size / 2, size, size);
    }

    function updateUserStats() {
        ajaxUpdateUserStats(game.user.id, game.user.name, game.cloudProvider, game.zone, game.host,
                            game.score.score, game.level, pacman.lives,
                            game.timer.getElapsedTimeSecs());
    }

    function buildWall(context,gridX,gridY,width,height) {
        console.log("BuildWall");
        width = width*2-1;
        height = height*2-1;
        context.fillRect(pacman.radius/2+gridX*2*pacman.radius,pacman.radius/2+gridY*2*pacman.radius, width*pacman.radius, height*pacman.radius);
    }

    function between(x, min, max) {
        return x >= min && x <= max;
    }

    // Logger
    var logger = function() {
        var oldConsoleLog = null;
        var pub = {};

        pub.enableLogger =  function enableLogger()
                            {
                                if(oldConsoleLog === null)
                                    return;

                                window['console']['log'] = oldConsoleLog;
                            };

        pub.disableLogger = function disableLogger()
                            {
                                oldConsoleLog = console.log;
                                window['console']['log'] = function() {};
                            };

        return pub;
    }();

    // stop watch to measure the time
    function Timer() {
        this.timeStop = 0;
        this.timeStart = 0;
        this.elapsedTime = 0;
        this.start = function() {
            this.timeStart = new Date();
        }
        this.stop = function() {
            this.timeStop = this.elapsedTime;
        }
        this.refresh = function(h) {
            this.updateTime();
            $(h).html("Time: " + this.getElapsedTimeSecs());
        }
        this.reset = function() {
            this.elapsedTime = 0;
            this.timeStop = 0;
            this.timeStart = new Date();
        }
        this.resume = function() {
            this.timeStart = new Date();
        }
        this.getElapsedTimeSecs = function() {
            return parseInt(this.elapsedTime / 1000);
        }
        this.updateTime = function() {
            if (!game.pause) {
                this.elapsedTime = new Date() - this.timeStart + this.timeStop;
            }
        }
    }

    function User() {
        this.id = 0;
        this.name = '';
        this.sentUpdate = false;
        this.livestats = false;

        this.resetSession = function () {
            this.id = 0;
            this.name = '';
            this.sentUpdate = false;
        };

        this.checkUpdateStats = function() {
            // Only send update once every time we hit databaseUpdateInterval
            var et = game.timer.getElapsedTimeSecs();
            if (et && ((et % game.databaseUpdateInterval) == 0)) {
                if (!this.sentUpdate) {
                    // Update database
                    updateUserStats();
                    this.sentUpdate = true;
                }
            } else { // reset sentUpdate
                this.sentUpdate = false;
            }
        }
    }

    // Manages the whole game ("God Object")
    function Game() {
        this.timer = new Timer();
        this.refreshRate = 33;        // speed of the game, will increase in higher levels
        this.databaseUpdateInterval = 10; // in seconds
        this.running = false;
        this.pause = true;
        this.cloudProvider = '';
        this.zone = '';
        this.host = '';
        this.user = new User();
        this.score = new Score();
        this.soundfx = 0;
        this.map;
        this.pillCount;                // number of pills
        this.monsters;
        this.level = 1;
        // Maximum level cap. Updated at runtime from GET /config and any saved
        // user override (see settings panel). May be a positive integer or 'unlimited'.
        this.maxLevel = FINAL_LEVEL;
        this.serverMaxLevel = FINAL_LEVEL;
        this.allowClientOverride = true;
        this.serverEbeeMode = false;
        this.allowEbeeModeOverride = true;
        this.ebeeMode = false;
        this.appRole = 'web';
        this.appVersion = 'dev';
        this.appVariant = 'stable';
        this.appColor = '#ffcc00';
        this.liveStatsPageSize = 10;
        this.showSimulatedUsers = true;
        this.ciliumLogo = new Image();
        this.ciliumLogo.src = CILIUM_LOGO_SRC;
        this.kubernetesLogo = new Image();
        this.kubernetesLogo.src = KUBERNETES_LOGO_SRC;
        this.refreshLevel = function(h) {
            $(h).html("Level: "+this.level);
        };
        this.gameOver = false;
        this.allLevelsCompleted = false;
        this.canvas = $("#myCanvas").get(0);
        this.wallColor = "Blue";
        this.width = this.canvas.width;
        this.height = this.canvas.height;

        this.pillSize = 3;
        this.powerpillSizeMin = 2;
        this.powerpillSizeMax = 6;
        this.powerpillSizeCurrent = this.powerpillSizeMax;
        this.powerPillAnimationCounter = 0;
        this.nextPowerPillSize = function() {
            /*if (this.powerPillAnimationCounter === 3) {
                this.powerPillAnimationCounter = 0;
                this.powerpillSizeCurrent = this.powerpillSizeMin + this.powerpillSizeCurrent % (this.powerpillSizeMax-this.powerpillSizeMin);
            } else {
                this.powerPillAnimationCounter++;
            }*/
            return this.powerpillSizeCurrent;
        };

        this.ghostFrightened = false;
        this.ghostFrightenedTimer = 240;
        this.ghostMode = 0;            // 0 = Scatter, 1 = Chase
        this.ghostModeTimer = 200;    // decrements each animationLoop execution
        this.ghostSpeedNormal = (this.level > 4 ? 3 : 2);    // global default for ghost speed
        this.ghostSpeedDazzled = 2; // global default for ghost speed when dazzled

        /* Game Functions */
        this.startGhostFrightened = function() {
            console.log("ghost frigthened");
            this.ghostFrightened = true;
            this.ghostFrightenedTimer = 240;
            inky.dazzle();
            pinky.dazzle();
            blinky.dazzle();
            clyde.dazzle();
        };

        this.endGhostFrightened = function() {
            console.log("ghost frigthened end");
            this.ghostFrightened = false;
            inky.undazzle();
            pinky.undazzle();
            blinky.undazzle();
            clyde.undazzle();
            };


        this.checkGhostMode = function() {
            if (this.ghostFrightened) {

                this.ghostFrightenedTimer--;
                if (this.ghostFrightenedTimer === 0) {
                    this.endGhostFrightened();
                    this.ghostFrigthenedTimer = 240;
                    /*inky.reverseDirection();
                    pinky.reverseDirection();
                    clyde.reverseDirection();
                    blinky.reverseDirection();*/
                }
            }
            // always decrement ghostMode timer
            this.ghostModeTimer--;
            if (this.ghostModeTimer === 0 && game.level > 1) {
                this.ghostMode ^= 1;
                this.ghostModeTimer = 200 + this.ghostMode * 450;
                console.log("ghostMode=" + this.ghostMode);

                game.buildWalls();

                inky.reverseDirection();
                pinky.reverseDirection();
                clyde.reverseDirection();
                blinky.reverseDirection();
                }
        };

        this.getMapContent = function (x, y) {
            var maxX = game.width / 30 -1;
            var maxY = game.height / 30 -1;
            if (x < 0) x = maxX + x;
            if (x > maxX) x = x-maxX;
            if (y < 0) y = maxY + y;
            if (y > maxY) y = y-maxY;
            return this.map.posY[y].posX[x].type;
        };

        this.setMapContent = function (x,y,val) {
            this.map.posY[y].posX[x].type = val;
        };

        this.toggleSound = function() {
            this.soundfx === 0 ? this.soundfx = 1 : this.soundfx = 0;
            $('#mute').toggle();
            };

        this.reset = function() {
            };

        this.newGame = function() {
            var r = confirm("Are you sure you want to restart?");
            if (r) {
                console.log("new Game");
                this.user.resetSession();
                this.init(0);
                this.pauseResume();
            }
        };

        this.restartLevel = function() {
            var r = confirm("Restart the current level?");
            if (r) {
                console.log("restart level " + this.level);
                this.pause = true;
                this.gameOver = false;
                this.init(1);
                this.showMessage("Level " + this.level, this.getLevelTitle() + "<br/>(Click to continue!)");
            }
        };

        this.nextLevel = function() {
            // Upstream v1.0.2/v1.0.5: cap the game at maxLevel and trigger end-game flow.
            // When maxLevel === 'unlimited' the game keeps progressing forever.
            if (this.maxLevel !== 'unlimited' && this.level >= this.maxLevel) {
                console.log('next level, ' + this.maxLevel + ', end game');
                game.endGame(true);
                game.showHighscoreForm();
                return;
            }
            this.level++;
            console.log("Level "+game.level);
            game.showMessage("Level "+game.level, this.getLevelTitle() + "<br/>(Click to continue!)");
            game.refreshLevel(".level");
            this.init(1);
        };

        this.drawHearts = function (count) {
            var html = "";
            var icon = game.ebeeMode ? KUBERNETES_LOGO_SRC : 'img/heart.png';
            for (var i = 0; i<count; i++) {
                html += " <img src='" + icon + "'>";
                }
            $(".lives").html("Lives: "+html);

        };

        this.showContent = function (id) {
            $('.content').hide();
            $('#'+id).show();
        };

        this.getLevelTitle = function() {
            if (this.ebeeMode) {
                if (this.maxLevel !== 'unlimited' && this.level === this.maxLevel) {
                    return '"final flower field"';
                }
                switch (this.level) {
                    case 1:
                        return '"first flight"';
                    case 2:
                        return '"pollen patrol"';
                    case 3:
                        return '"flower chase"';
                    case 4:
                        return '"hive traffic"';
                    case 5:
                        return '"cilium bloom"';
                    default:
                        return '"keep buzzing"';
                }
            }

            switch(this.level) {
                case 2:
                    return '"The chase begins"';
                    // activate chase / scatter switching
                case 3:
                    return '"Inky\s awakening"';
                    // Inky starts leaving the ghost house
                case 4:
                    return '"Clyde\s awakening"';
                    // Clyde starts leaving the ghost house
                case 5:
                    return '"need for speed"';
                    // All the ghosts get faster from now on
                case 6:
                    return '"hunting season 1"';
                    // TODO: No scatter mood this time
                case 7:
                    return '"the big calm"';
                    // TODO: Only scatter mood this time
                case 8:
                    return '"hunting season 2"';
                    // TODO: No scatter mood and all ghosts leave instantly
                case 9:
                    return '"ghosts on speed"';
                    // TODO: Ghosts get even faster for this level
                default:
                    // "The final chase" once we hit the configured cap (if finite).
                    if (this.maxLevel !== 'unlimited' && this.level === this.maxLevel) {
                        return '"The final chase"';
                    }
                    return '"nothing new"';
            }
        }

        // Upstream v1.0.2: client-side score sanity check. Max points per level is
        //   104 pills + 4 powerpills + 4 ghosts in beast mode
        // If score/level exceeds that, the score is rejected as fake.
        this.validateScoreWithLevel = function () {
            const maxLevelPointsPills = 104 * PILL_POINTS;
            const maxLevelPointsPowerpills = 4 * POWERPILL_POINTS;
            const maxLevelPointsGhosts = 4 * 4 * GHOST_POINTS;
            const maxLevelPoints = maxLevelPointsPills + maxLevelPointsPowerpills + maxLevelPointsGhosts;
            const scoreIsValid = this.score.score / this.level <= maxLevelPoints;
            console.log('validate score. score: ' + this.score.score + ', level: ' + this.level, scoreIsValid);
            return scoreIsValid;
        };

        // Upstream v1.0.5: explicit end-game state transition.
        this.endGame = function (allLevelsCompleted) {
            allLevelsCompleted = !!allLevelsCompleted;
            console.log('Game Over by ' + (allLevelsCompleted ? 'WIN' : 'LOSS'));
            this.pause = true;
            this.gameOver = true;
            this.allLevelsCompleted = allLevelsCompleted;
        };

        // Upstream v1.0.5: gate the highscore form on validateScoreWithLevel().
        this.showHighscoreForm = function () {
            var scoreIsValid = this.validateScoreWithLevel();
            var localOnly = this.serverMaxLevel !== 'unlimited' && this.level > this.serverMaxLevel;
            var localOnlyHTML = localOnly
                ? "<div id='local-only-warning'>This run went beyond the server max level, so the leaderboard may reject it as local play only.</div>"
                : "";
            var inputHTML = scoreIsValid
                ? localOnlyHTML + "<div id='highscore-form'><span id='form-validator'></span><input type='text' id='playerName'/><span class='button' id='score-submit'>save</span></div>"
                : "<div id='invalid-score'>Your score looks fake, the highscore list is only for honest players ;)</div>";
            var title = this.ebeeMode ? (this.allLevelsCompleted ? "Hive secured" : "Flight over") : "Game over";
            this.showMessage(title, "Total Score: " + this.score.score + (HIGHSCORE_ENABLED ? inputHTML : ''));
            if (scoreIsValid) $('#playerName').val(this.user.name).focus();
        };

        this.showMessage = function(title, text) {
            this.timer.stop();
            this.pause = true;
            $('#canvas-overlay-container').fadeIn(200);
            if ($('.controls').css('display') != "none") $('.controls').slideToggle(200);
            $('#canvas-overlay-content #title').text(title);
            $('#canvas-overlay-content #text').html(text);
        };

        this.closeMessage = function() {
            $('#canvas-overlay-container').fadeOut(200);
            $('.controls').slideToggle(200);
        };

        this.pauseResume = function () {
            if (!this.running) {
                if (!this.user.name) {
                    var name = window.prompt('Enter your name to start the game:');
                    if (name === null || !name.trim()) return;
                    this.user.name = name.trim().slice(0, 32);
                }
                getUserId(this.user.name);
                // start timer
                this.timer.start();
                this.pause = false;
                this.running = true;
                this.closeMessage();
                animationLoop();
            }
            else if (this.pause) {
                // resume timer
                this.timer.resume();
                this.pause = false;
                this.closeMessage();
            }
            else {
                // pause timer
                this.timer.stop();
                this.showMessage("Pause","Click to Resume");
            }
        };

        this.init = function (state) {

            console.log("init game "+state);

            // reset timer if restart
            if( state === 0 ) {
                this.timer.reset();
            }

            // get Level Map
            $.ajax({
                url: mapConfig,
                async: false,
                 beforeSend: function(xhr){
                    if (xhr.overrideMimeType) xhr.overrideMimeType("application/json");
                },
                dataType: "json",
                success: function (data) {
                    game.map =  data;
                }
            });

            var temp = 0;
            $.each(this.map.posY, function(i, item) {
               $.each(this.posX, function() {
                   if (this.type == "pill") {
                    temp++;
                    //console.log("Pill Count++. temp="+temp+". PillCount="+this.pillCount+".");
                    }
                });
            });

            this.pillCount = temp;

            if (state === 0) {
                this.score.set(0);
                this.score.refresh(".score");
                pacman.lives = 3;
                game.level = 1;
                this.refreshLevel(".level");
                game.gameOver = false;
                game.allLevelsCompleted = false;
            }
            pacman.reset();

            game.drawHearts(pacman.lives);

            this.ghostFrightened = false;
            this.ghostFrightenedTimer = 240;
            this.ghostMode = 0;            // 0 = Scatter, 1 = Chase
            this.ghostModeTimer = 200;    // decrements each animationLoop execution

            // initalize Ghosts, avoid memory flooding
            if (pinky === null || pinky === undefined) {
                pinky = new Ghost("pinky",7,5,'img/pinky.svg',2,2);
                inky = new Ghost("inky",8,5,'img/inky.svg',13,11);
                blinky = new Ghost("blinky",9,5,'img/blinky.svg',13,0);
                clyde = new Ghost("clyde",10,5,'img/clyde.svg',2,11);
            }
            else {
                //console.log("ghosts reset");
                pinky.reset();
                inky.reset();
                blinky.reset();
                clyde.reset();
            }
            blinky.start();    // blinky is the first to leave ghostHouse
            inky.start();
            pinky.start();
            clyde.start();
        };

        this.check = function() {
        if ((this.pillCount === 0) && game.running) {
                this.nextLevel();
            }
        };

        this.win = function () {};
        this.gameover = function () {};

        this.toPixelPos = function (gridPos) {
            return gridPos*30;
        };

        this.toGridPos = function (pixelPos) {
            return ((pixelPos % 30)/30);
        };

        /* ------------ Start Pre-Build Walls  ------------ */
        this.buildWalls = function() {
            if (this.ghostMode === 0) game.wallColor = "Blue";
            else game.wallColor = "Red";
            canvas_walls = document.createElement('canvas');
            canvas_walls.width = game.canvas.width;
            canvas_walls.height = game.canvas.height;
            context_walls = canvas_walls.getContext("2d");

            context_walls.fillStyle = game.wallColor;
            context_walls.strokeStyle = game.wallColor;

            //horizontal outer
            buildWall(context_walls,0,0,18,1);
            buildWall(context_walls,0,12,18,1);

            // vertical outer
            buildWall(context_walls,0,0,1,6);
            buildWall(context_walls,0,7,1,6);
            buildWall(context_walls,17,0,1,6);
            buildWall(context_walls,17,7,1,6);

            // ghost base
            buildWall(context_walls,7,4,1,1);
            buildWall(context_walls,6,5,1,2);
            buildWall(context_walls,10,4,1,1);
            buildWall(context_walls,11,5,1,2);
            buildWall(context_walls,6,6,6,1);

            // ghost base door
            context_walls.fillRect(8*2*pacman.radius,pacman.radius/2+4*2*pacman.radius+5, 4*pacman.radius, 1);

            // single blocks
            buildWall(context_walls,4,0,1,2);
            buildWall(context_walls,13,0,1,2);

            buildWall(context_walls,2,2,1,2);
            buildWall(context_walls,6,2,2,1);
            buildWall(context_walls,15,2,1,2);
            buildWall(context_walls,10,2,2,1);

            buildWall(context_walls,2,3,2,1);
            buildWall(context_walls,14,3,2,1);
            buildWall(context_walls,5,3,1,1);
            buildWall(context_walls,12,3,1,1);
            buildWall(context_walls,3,3,1,3);
            buildWall(context_walls,14,3,1,3);

            buildWall(context_walls,3,4,1,1);
            buildWall(context_walls,14,4,1,1);

            buildWall(context_walls,0,5,2,1);
            buildWall(context_walls,3,5,2,1);
            buildWall(context_walls,16,5,2,1);
            buildWall(context_walls,13,5,2,1);

            buildWall(context_walls,0,7,2,2);
            buildWall(context_walls,16,7,2,2);
            buildWall(context_walls,3,7,2,2);
            buildWall(context_walls,13,7,2,2);

            buildWall(context_walls,4,8,2,2);
            buildWall(context_walls,12,8,2,2);
            buildWall(context_walls,5,8,3,1);
            buildWall(context_walls,10,8,3,1);

            buildWall(context_walls,2,10,1,1);
            buildWall(context_walls,15,10,1,1);
            buildWall(context_walls,7,10,4,1);
            buildWall(context_walls,4,11,2,2);
            buildWall(context_walls,12,11,2,2);
            /* ------------ End Pre-Build Walls  ------------ */
        };

    }

    game = new Game();



    function Score() {
        this.score = 0;
        this.set = function(i) {
            this.score = i;
        };
        this.add = function(i) {
            this.score += i;
        };
        this.refresh = function(h) {
            $(h).html("Score: "+this.score);
        };

    }



    // used to play sounds during the game
    var Sound = {};
    Sound.play = function (sound) {
        if (game.soundfx == 1) {
            var audio = document.getElementById(sound);
            (audio !== null) ? audio.play() : console.log(sound+" not found");
            }
    };


    // Direction object in Constructor notation
    function Direction(name,angle1,angle2,dirX,dirY) {
        this.name = name;
        this.angle1 = angle1;
        this.angle2 = angle2;
        this.dirX = dirX;
        this.dirY = dirY;
        this.equals = function(dir) {
            return  JSON.stringify(this) ==  JSON.stringify(dir);
        };
    }

    // Direction Objects
    var up = new Direction("up",1.75,1.25,0,-1);        // UP
    var left = new Direction("left",1.25,0.75,-1,0);    // LEFT
    var down = new Direction("down",0.75,0.25,0,1);        // DOWN
    var right = new Direction("right",0.25,1.75,1,0);    //
    /*var directions = [{},{},{},{}];
    directions[0] = up;
    directions[1] = down;
    directions[2] = right;
    directions[3] = left;*/


    // DirectionWatcher
    function directionWatcher() {
        this.dir = null;
        this.set = function(dir) {
            this.dir = dir;
        };
        this.get = function() {
            return this.dir;
        };
    }

    //var directionWatcher = new directionWatcher();

    // Ghost object in Constructor notation
    function Ghost(name, gridPosX, gridPosY, image, gridBaseX, gridBaseY) {
        this.name = name;
        this.posX = gridPosX * 30;
        this.posY = gridPosY * 30;
        this.startPosX = gridPosX * 30;
        this.startPosY = gridPosY * 30;
        this.gridBaseX = gridBaseX;
        this.gridBaseY = gridBaseY;
        this.speed = game.ghostSpeedNormal;
        this.images = JSON.parse(
            '{"normal" : {'
                + '"inky" : "0",'
                + '"pinky" : "1",'
                + '"blinky" : "2",'
                + '"clyde" : "3"'
                + '},'
            +
            '"frightened1" : {'
                +
                '"left" : "", "up": "", "right" : "", "down": ""},'
            +
            '"frightened2" : {'
                +
                '"left" : "", "up": "", "right" : "", "down": ""},'
            +
            '"dead" : {'
                +
                '"left" : "", "up": "", "right" : "", "down": ""}}'
            );
        this.image = new Image();
        this.image.src = image;
        this.ghostHouse = true;
        this.dazzled = false;
        this.dead = false;
        this.dazzle = function() {
            this.changeSpeed(game.ghostSpeedDazzled);
            // ensure ghost doesnt leave grid
            if (this.posX > 0) this.posX = this.posX - this.posX % this.speed;
            if (this.posY > 0) this.posY = this.posY - this.posY % this.speed;
            this.dazzled = true;
        }
        this.undazzle = function() {
            // only change speed if ghost is not "dead"
            if (!this.dead) this.changeSpeed(game.ghostSpeedNormal);
            // ensure ghost doesnt leave grid
            if (this.posX > 0) this.posX = this.posX - this.posX % this.speed;
            if (this.posY > 0) this.posY = this.posY - this.posY % this.speed;
            this.dazzled = false;
        }
        this.dazzleImg = new Image();
        this.dazzleImg.src = 'img/dazzled.svg';
        this.dazzleImg2 = new Image();
        this.dazzleImg2.src = 'img/dazzled2.svg';
        this.deadImg = new Image();
        this.deadImg.src = 'img/dead.svg';
        this.direction = right;
        this.radius = pacman.radius;
        this.draw = function (context) {
            if (game.ebeeMode) {
                drawFlower(context, this);
                return;
            }
            if (this.dead) {
                context.drawImage(this.deadImg, this.posX, this.posY, 2*this.radius, 2*this.radius);
            }
            else if (this.dazzled) {
                if (pacman.beastModeTimer < 50 && pacman.beastModeTimer % 8 > 1) {
                    context.drawImage(this.dazzleImg2, this.posX, this.posY, 2*this.radius, 2*this.radius);
                } else {
                    context.drawImage(this.dazzleImg, this.posX, this.posY, 2*this.radius, 2*this.radius);
                }
            }
            else context.drawImage(this.image, this.posX, this.posY, 2*this.radius, 2*this.radius);
        }
        this.getCenterX = function () {
            return this.posX+this.radius;
        }
        this.getCenterY = function () {
            return this.posY+this.radius;
        }

        this.reset = function() {
            this.dead = false;
            this.posX = this.startPosX;
            this.posY = this.startPosY;
            this.ghostHouse = true;
            this.undazzle();
        }

        this.die = function() {
            if (!this.dead) {
                game.score.add(GHOST_POINTS);
                //this.reset();
                this.dead = true;
                this.changeSpeed(game.ghostSpeedNormal);
            }
        }
        this.changeSpeed = function(s) {
            // adjust gridPosition to new speed
            this.posX = Math.round(this.posX / s) * s;
            this.posY = Math.round(this.posY / s) * s;
            this.speed = s;
        }

        this.move = function() {

            this.checkDirectionChange();
            this.checkCollision();

            // leave Ghost House
            if (this.ghostHouse == true) {

                // Clyde does not start chasing before 2/3 of all pills are eaten and if level is < 4
                if (this.name == "clyde") {
                    if ((game.level < 4) || ((game.pillCount > 104/3))) this.stop = true;
                    else this.stop = false;
                }
                // Inky starts after 30 pills and only from the third level on
                if (this.name == "inky") {
                    if ((game.level < 3) || ((game.pillCount > 104-30))) this.stop = true;
                    else this.stop = false;
                }

                if ((this.getGridPosY() == 5) && this.inGrid()) {
                    if ((this.getGridPosX() == 7)) this.setDirection(right);
                    if ((this.getGridPosX() == 8) || this.getGridPosX() == 9) this.setDirection(up);
                    if ((this.getGridPosX() == 10)) this.setDirection(left);
                }
                if ((this.getGridPosY() == 4) && ((this.getGridPosX() == 8) || (this.getGridPosX() == 9)) && this.inGrid()) {
                    console.log("ghosthouse -> false");
                    this.ghostHouse = false;
                    }
            }

            if (!this.stop) {
            // Move
                this.posX += this.speed * this.dirX;
                this.posY += this.speed * this.dirY;

                // Check if out of canvas
                if (this.posX >= game.width-this.radius) this.posX = this.speed-this.radius;
                if (this.posX <= 0-this.radius) this.posX = game.width-this.speed-this.radius;
                if (this.posY >= game.height-this.radius) this.posY = this.speed-this.radius;
                if (this.posY <= 0-this.radius) this.posY = game.height-this.speed-this.radius;
            }
        }

        this.checkCollision = function() {

            /* Check Back to Home */
            if (this.dead && (this.getGridPosX() == this.startPosX /30) && (this.getGridPosY() == this.startPosY / 30)) this.reset();
            else {

                /* Check Ghost / Pacman Collision            */
                var collisionRange = game.ebeeMode ? 15 : 10;
                if ((between(pacman.getCenterX(), this.getCenterX()-collisionRange, this.getCenterX()+collisionRange))
                    && (between(pacman.getCenterY(), this.getCenterY()-collisionRange, this.getCenterY()+collisionRange)))
                {
                    if ((!this.dazzled) && (!this.dead)) {
                        pacman.die();
                        }
                    else {
                        this.die();
                    }
                }
            }
        }

        /* Pathfinding */
        this.getNextDirection = function() {
            // get next field
            var pX = this.getGridPosX();
            var pY= this.getGridPosY();
            game.getMapContent(pX,pY);
            var u, d, r, l;             // option up, down, right, left

            // get target
            if (this.dead) {            // go Home
                var tX = this.startPosX / 30;
                var tY = this.startPosY / 30;
                }
            else if (game.ghostMode == 0) {            // Scatter Mode
                var tX = this.gridBaseX;
                var tY = this.gridBaseY;
            } else if (game.ghostMode == 1) {            // Chase Mode

                switch (this.name) {

                // target: 4 ahead and 4 left of pacman
                case "pinky":
                    var pdir = pacman.direction;
                    var pdirX = pdir.dirX == 0 ? - pdir.dirY : pdir.dirX;
                    var pdirY = pdir.dirY == 0 ? - pdir.dirX : pdir.dirY;

                    var tX = (pacman.getGridPosX() + pdirX*4) % (game.width / pacman.radius +1);
                    var tY = (pacman.getGridPosY() + pdirY*4) % (game.height / pacman.radius +1);
                    break;

                // target: pacman
                case "blinky":
                    var tX = pacman.getGridPosX();
                    var tY = pacman.getGridPosY();
                    break;

                // target:
                case "inky":
                    var tX = pacman.getGridPosX() + 2*pacman.direction.dirX;
                    var tY = pacman.getGridPosY() + 2*pacman.direction.dirY;
                    var vX = tX - blinky.getGridPosX();
                    var vY = tY - blinky.getGridPosY();
                    tX = Math.abs(blinky.getGridPosX() + vX*2);
                    tY = Math.abs(blinky.getGridPosY() + vY*2);
                    break;

                // target: pacman, until pacman is closer than 5 grid fields, then back to scatter
                case "clyde":
                    var tX = pacman.getGridPosX();
                    var tY = pacman.getGridPosY();
                    var dist = Math.sqrt(Math.pow((pX-tX),2) + Math.pow((pY - tY),2));

                    if (dist < 5) {
                        tX = this.gridBaseX;
                        tY = this.gridBaseY;
                    }
                    break;

                }
            }


            var oppDir = this.getOppositeDirection();    // ghosts are not allowed to change direction 180°

            var dirs = [{},{},{},{}];
            dirs[0].field = game.getMapContent(pX,pY-1);
            dirs[0].dir = up;
            dirs[0].distance = Math.sqrt(Math.pow((pX-tX),2) + Math.pow((pY -1 - tY),2));

            dirs[1].field = game.getMapContent(pX,pY+1);
            dirs[1].dir = down;
            dirs[1].distance = Math.sqrt(Math.pow((pX-tX),2) + Math.pow((pY+1 - tY),2));

            dirs[2].field = game.getMapContent(pX+1,pY);
            dirs[2].dir = right;
            dirs[2].distance = Math.sqrt(Math.pow((pX+1-tX),2) + Math.pow((pY - tY),2));

            dirs[3].field = game.getMapContent(pX-1,pY);
            dirs[3].dir = left;
            dirs[3].distance = Math.sqrt(Math.pow((pX-1-tX),2) + Math.pow((pY - tY),2));

            // Sort possible directions by distance
            function compare(a,b) {
              if (a.distance < b.distance)
                 return -1;
              if (a.distance > b.distance)
                return 1;
              return 0;
            }
            var dirs2 = dirs.sort(compare);

            var r = this.dir;
            var j;

            if (this.dead) {
                for (var i = dirs2.length-1; i >= 0; i--) {
                    if ((dirs2[i].field != "wall") && !(dirs2[i].dir.equals(this.getOppositeDirection()))) {
                    r = dirs2[i].dir;
                    }
                }
            }
            else {
                for (var i = dirs2.length-1; i >= 0; i--) {
                    if ((dirs2[i].field != "wall") && (dirs2[i].field != "door") && !(dirs2[i].dir.equals(this.getOppositeDirection()))) {
                        r = dirs2[i].dir;
                        }
                }
            }
            this.directionWatcher.set(r);
            return r;
        }
        this.setRandomDirection = function() {
             var dir = Math.floor((Math.random()*10)+1)%5;

             switch(dir) {
                case 1:
                    if (this.getOppositeDirection().equals(up)) this.setDirection(down);
                    else this.setDirection(up);
                    break;
                case 2:
                    if (this.getOppositeDirection().equals(down)) this.setDirection(up);
                    else this.setDirection(down);
                    break;
                case 3:
                    if (this.getOppositeDirection().equals(right)) this.setDirection(left);
                    else this.setDirection(right);
                    break;
                case 4:
                    if (this.getOppositeDirection().equals(left)) this.setDirection(right);
                    else this.setDirection(left);
                    break;
             }
        }
        this.reverseDirection = function() {
            console.log("reverseDirection: "+this.direction.name+" to "+this.getOppositeDirection().name);
            this.directionWatcher.set(this.getOppositeDirection());
        }

    }

    Ghost.prototype = new Figure();

    // Super Class for Pacman & Ghosts
    function Figure() {
        this.posX;
        this.posY;
        this.speed;
        this.dirX = right.dirX;
        this.dirY = right.dirY;
        this.direction;
        this.stop = true;
        this.directionWatcher = new directionWatcher();
        this.getNextDirection = function() { console.log("Figure getNextDirection");};
        this.checkDirectionChange = function() {
            if (this.inGrid() && (this.directionWatcher.get() == null)) this.getNextDirection();
            if ((this.directionWatcher.get() != null) && this.inGrid()) {
                //console.log("changeDirection to "+this.directionWatcher.get().name);
                this.setDirection(this.directionWatcher.get());
                this.directionWatcher.set(null);
            }

        }


        this.inGrid = function() {
            if((this.posX % (2*this.radius) === 0) && (this.posY % (2*this.radius) === 0)) return true;
            return false;
        }
        this.getOppositeDirection = function() {
            if (this.direction.equals(up)) return down;
            else if (this.direction.equals(down)) return up;
            else if (this.direction.equals(right)) return left;
            else if (this.direction.equals(left)) return right;
        }
        this.move = function() {

            if (!this.stop) {
                this.posX += this.speed * this.dirX;
                this.posY += this.speed * this.dirY;

                // Check if out of canvas
                if (this.posX >= game.width-this.radius) this.posX = this.speed-this.radius;
                if (this.posX <= 0-this.radius) this.posX = game.width-this.speed-this.radius;
                if (this.posY >= game.height-this.radius) this.posY = this.speed-this.radius;
                if (this.posY <= 0-this.radius) this.posY = game.height-this.speed-this.radius;
                }
            }
        this.stop = function() { this.stop = true;}
        this.start = function() { this.stop = false;}

        this.getGridPosX = function() {
            return (this.posX - (this.posX % 30))/30;
        }
        this.getGridPosY = function() {
            return (this.posY - (this.posY % 30))/30;
        }
        this.setDirection = function(dir) {
            this.dirX = dir.dirX;
            this.dirY = dir.dirY;
            this.angle1 = dir.angle1;
            this.angle2 = dir.angle2;
            this.direction = dir;
        }
        this.setPosition = function(x, y) {
            this.posX = x;
            this.posY = y;
        }
    }

    function pacman() {
        this.radius = 15;
        this.posX = 0;
        this.posY = 6*2*this.radius;
        this.speed = 5;
        this.angle1 = 0.25;
        this.angle2 = 1.75;
        this.mouth = 1; /* Switches between 1 and -1, depending on mouth closing / opening */
        this.dirX = right.dirX;
        this.dirY = right.dirY;
        this.lives = 3;
        this.stuckX = 0;
        this.stuckY = 0;
        this.frozen = false;        // used to play die Animation
        this.freeze = function () {
            this.frozen = true;
        }
        this.unfreeze = function() {
            this.frozen = false;
        }
        this.getCenterX = function () {
            return this.posX+this.radius;
        }
        this.getCenterY = function () {
            return this.posY+this.radius;
        }
        this.directionWatcher = new directionWatcher();

        this.direction = right;

        this.beastMode = false;
        this.beastModeTimer = 0;

        this.checkCollisions = function () {

            if ((this.stuckX == 0) && (this.stuckY == 0) && this.frozen == false) {

                // Get the Grid Position of Pac
                var gridX = this.getGridPosX();
                var gridY = this.getGridPosY();
                var gridAheadX = gridX;
                var gridAheadY = gridY;

                var field = game.getMapContent(gridX, gridY);

                // get the field 1 ahead to check wall collisions
                if ((this.dirX == 1) && (gridAheadX < 17)) gridAheadX += 1;
                if ((this.dirY == 1) && (gridAheadY < 12)) gridAheadY += 1;
                var fieldAhead = game.getMapContent(gridAheadX, gridAheadY);


                /*    Check Pill Collision            */
                if ((field === "pill") || (field === "powerpill")) {
                    //console.log("Pill found at ("+gridX+"/"+gridY+"). Pacman at ("+this.posX+"/"+this.posY+")");
                    if (
                        // Upstream PR #57: use this.speed instead of hardcoded 5 so collision still works at non-default speeds.
                        ((this.dirX == 1) && (between(this.posX, game.toPixelPos(gridX)+this.radius-this.speed, game.toPixelPos(gridX+1))))
                        || ((this.dirX == -1) && (between(this.posX, game.toPixelPos(gridX), game.toPixelPos(gridX)+this.speed)))
                        || ((this.dirY == 1) && (between(this.posY, game.toPixelPos(gridY)+this.radius-this.speed, game.toPixelPos(gridY+1))))
                        || ((this.dirY == -1) && (between(this.posY, game.toPixelPos(gridY), game.toPixelPos(gridY)+this.speed)))
                        || (fieldAhead === "wall")
                        )
                        {    var s;
                            if (field === "powerpill") {
                                Sound.play("powerpill");
                                s = POWERPILL_POINTS;
                                this.enableBeastMode();
                                game.startGhostFrightened();
                                }
                            else {
                                Sound.play("waka");
                                s = PILL_POINTS;
                                game.pillCount--;
                                }
                            game.map.posY[gridY].posX[gridX].type = "null";
                            game.score.add(s);
                        }
                }

                /*    Check Wall Collision            */
                if ((fieldAhead === "wall") || (fieldAhead === "door")) {
                    this.stuckX = this.dirX;
                    this.stuckY = this.dirY;
                    pacman.stop();
                    // get out of the wall
                    // Bug fix: operator precedence. `posX % 2*radius` parses as `(posX%2)*radius`,
                    // which is almost never zero and caused spurious nudges. Use `posX % (2*radius)`.
                    // Upstream PR #57: use this.speed instead of hardcoded 5.
                    if ((this.stuckX == 1) && ((this.posX % (2 * this.radius)) != 0)) this.posX -= this.speed;
                    if ((this.stuckY == 1) && ((this.posY % (2 * this.radius)) != 0)) this.posY -= this.speed;
                    if (this.stuckX == -1) this.posX += this.speed;
                    if (this.stuckY == -1) this.posY += this.speed;
                }

            }
        }
        this.checkDirectionChange = function() {
            if (this.directionWatcher.get() != null) {
                //console.log("next Direction: "+directionWatcher.get().name);

                if ((this.stuckX == 1) && this.directionWatcher.get() == right) this.directionWatcher.set(null);
                else {
                    // reset stuck events
                    this.stuckX = 0;
                    this.stuckY = 0;


                    // only allow direction changes inside the grid
                    if ((this.inGrid())) {
                        //console.log("changeDirection to "+directionWatcher.get().name);

                        // check if possible to change direction without getting stuck
                        console.log("x: "+this.getGridPosX()+" + "+this.directionWatcher.get().dirX);
                        console.log("y: "+this.getGridPosY()+" + "+this.directionWatcher.get().dirY);
                        var x = this.getGridPosX()+this.directionWatcher.get().dirX;
                        var y = this.getGridPosY()+this.directionWatcher.get().dirY;
                        // Bug fix: the original code assigned to `x` in the upward-wrap branch
                        // (`if (y <= -1) x = ...`) and used the typo `game.heigth` in the
                        // downward-wrap branch. Together this made pacman teleport horizontally
                        // through the centre of the board when input pushed him off the top/bottom.
                        if (x <= -1) x = game.width/(this.radius*2)-1;
                        if (x >= game.width/(this.radius*2)) x = 0;
                        if (y <= -1) y = game.height/(this.radius*2)-1;
                        if (y >= game.height/(this.radius*2)) y = 0;

                        var nextTile = game.map.posY[y].posX[x].type;

                        if (nextTile != "wall") {
                            this.setDirection(this.directionWatcher.get());
                            this.directionWatcher.set(null);
                        }
                    }
                }
            }
        }
        this.setDirection = function(dir) {
            if (!this.frozen) {
                this.dirX = dir.dirX;
                this.dirY = dir.dirY;
                this.angle1 = dir.angle1;
                this.angle2 = dir.angle2;
                this.direction = dir;
            }
        }
        this.enableBeastMode = function() {
            this.beastMode = true;
            this.beastModeTimer = 240;
            //console.log("Beast Mode activated!");
            inky.dazzle();
            pinky.dazzle();
            blinky.dazzle();
            clyde.dazzle();
        };
        this.disableBeastMode = function() {
            this.beastMode = false;
            //console.log("Beast Mode is over!");
            inky.undazzle();
            pinky.undazzle();
            blinky.undazzle();
            clyde.undazzle();
            };
        this.move = function() {

            if (!this.frozen) {
                if (this.beastModeTimer > 0) {
                    this.beastModeTimer--;
                    //console.log("Beast Mode: "+this.beastModeTimer);
                    }
                if ((this.beastModeTimer == 0) && (this.beastMode == true)) this.disableBeastMode();

                this.posX += this.speed * this.dirX;
                this.posY += this.speed * this.dirY;

                // Check if out of canvas
                if (this.posX >= game.width-this.radius) this.posX = 5-this.radius;
                if (this.posX <= 0-this.radius) this.posX = game.width-5-this.radius;
                if (this.posY >= game.height-this.radius) this.posY = 5-this.radius;
                if (this.posY <= 0-this.radius) this.posY = game.height-5-this.radius;
            }
            else this.dieAnimation();
        }

        this.eat = function () {

            if (!this.frozen) {
                if (this.dirX == this.dirY == 0) {

                    this.angle1 -= this.mouth*0.07;
                    this.angle2 += this.mouth*0.07;

                    var limitMax1 = this.direction.angle1;
                    var limitMax2 = this.direction.angle2;
                    var limitMin1 = this.direction.angle1 - 0.21;
                    var limitMin2 = this.direction.angle2 + 0.21;

                    if (this.angle1 < limitMin1 || this.angle2 > limitMin2)
                    {
                        this.mouth = -1;
                    }
                    if (this.angle1 >= limitMax1 || this.angle2 <= limitMax2)
                    {
                        this.mouth = 1;
                    }
                }
            }
        }
        this.stop = function() {
            this.dirX = 0;
            this.dirY = 0;
        }
        this.reset = function() {
            this.unfreeze();
            this.posX = 0;
            this.posY = 6*2*this.radius;
            this.setDirection(right);
            this.stop();
            this.stuckX = 0;
            this.stuckY = 0;
            //console.log("reset pacman");
        }
        this.dieAnimation = function() {
            this.angle1 += 0.05;
            this.angle2 -= 0.05;
            if (this.angle1 >= this.direction.angle1+0.7 || this.angle2 <= this.direction.angle2-0.7) {
                this.dieFinal();
                }
        }
        this.die = function() {
            Sound.play("die");
            this.freeze();
            this.dieAnimation();
            }
        this.dieFinal = function() {
            this.reset();
            pinky.reset();
            inky.reset();
            blinky.reset();
            clyde.reset();
            this.lives--;
            console.log("pacman died, "+this.lives+" lives left");
            if (this.lives <= 0) {
                // Upstream v1.0.5: route through endGame() + showHighscoreForm() so score validation runs.
                game.endGame(false);
                game.showHighscoreForm();
                }
            game.drawHearts(this.lives);
        }
        this.getGridPosX = function() {
            return (this.posX - (this.posX % 30))/30;
        }
        this.getGridPosY = function() {
            return (this.posY - (this.posY % 30))/30;
        }
    }
    pacman.prototype = new Figure();
    var pacman = new pacman();
    game.buildWalls();


// Check if a new cache is available on page load.
function checkAppCache() {
    console.log('check AppCache');
    window.applicationCache.addEventListener('updateready', function(e)
    {
        console.log("AppCache: updateready");
        if (window.applicationCache.status == window.applicationCache.UPDATEREADY) {

            // Browser downloaded a new app cache.
            // Swap it in and reload the page to get the new hotness.
            window.applicationCache.swapCache();
            if (confirm('A new version of this site is available. Load it?')) {
                window.location.reload();
            }

        } else {
        // Manifest didn't change. Nothing new to server.
        }
    }, false);

    window.applicationCache.addEventListener('cached', function(e)
    {
        console.log("AppCache: cached");
    }, false);

}


    // Action starts here:

    function hideAdressbar() {
        console.log("hide adressbar");
        $("html").scrollTop(1);
        $("body").scrollTop(1);
    }

    $(document).ready(function() {

        $.ajaxSetup({ mimeType: "application/json" });

        $.ajaxSetup({beforeSend: function(xhr){
            if (xhr.overrideMimeType){
                xhr.overrideMimeType("application/json");
                //console.log("mimetype set to json");
                }
            }
        });

        // Hide address bar
        hideAdressbar();

        // Get and show cloud location metadata
        getCloudMetadata();

        // Apply any saved user override immediately, then refresh from server.
        applyEbeeMode();
        applyMaxLevel();
        fetchServerConfig();

        if (window.applicationCache != null) checkAppCache();

        /* -------------------- EVENT LISTENERS -------------------------- */

        // Listen for resize changes
        /*window.addEventListener("resize", function() {
            // Get screen size (inner/outerWidth, inner/outerHeight)
            // deactivated because of problems
            if ((window.outerHeight < window.outerWidth) && (window.outerHeight < 720)) {
            game.showMessage("Rotate Device","Your screen is too small to play in landscape view.");
            console.log("rotate your device to portrait!");
            }
        }, false);*/


        // --------------- Controls


        // Keyboard
        window.addEventListener('keydown',doKeyDown,true);

        $('#canvas-container').click(function() {
            if (!(game.gameOver == true))    game.pauseResume();
        });

        $('body').on('click', '#score-submit', function(){
            console.log("submit highscore pressed");
            if ($('#playerName').val() === "" || $('#playerName').val() === undefined) {
                $('#form-validator').html("Please enter a name<br/>");
            } else {
                $('#form-validator').html("");
                addHighscore();
            }
        });

        $('body').on('click', '#show-highscore', function(){
            game.showContent('highscore-content');
            getHighscore();
        });

        $(document).on('change', '#highscore-show-simulated, #livestats-show-simulated', function () {
            game.showSimulatedUsers = $(this).is(':checked');
            if ($(this).is('#highscore-show-simulated')) {
                getHighscore(1);
            } else {
                getLiveStats(1);
            }
        });

        $(document).on('click', '#highscore-pagination [data-page-action]', function () {
            if ($(this).is(':disabled')) return;
            getHighscore($(this).data('page-action') === 'next' ? highscorePage + 1 : highscorePage - 1);
        });

        $(document).on('click', '#livestats-pagination [data-page-action]', function () {
            if ($(this).is(':disabled')) return;
            getLiveStats($(this).data('page-action') === 'next' ? livestatsPage + 1 : livestatsPage - 1);
        });

        // Hammerjs Touch Events
        /*Hammer('#canvas-container').on("tap", function(event) {
            if (!(game.gameOver == true))    game.pauseResume();
        });*/
        Hammer('.container').on("swiperight", function(event) {
            if ($('#game-content').is(":visible")) {
                event.gesture.preventDefault();
                pacman.directionWatcher.set(right);
                }
        });
        Hammer('.container').on("swipeleft", function(event) {
            if ($('#game-content').is(":visible")) {
                event.gesture.preventDefault();
                pacman.directionWatcher.set(left);
            }
        });
        Hammer('.container').on("swipeup", function(event) {
            if ($('#game-content').is(":visible")) {
                event.gesture.preventDefault();
                pacman.directionWatcher.set(up);
            }
        });
        Hammer('.container').on("swipedown", function(event) {
            if ($('#game-content').is(":visible")) {
                event.gesture.preventDefault();
                pacman.directionWatcher.set(down);
            }
        });

        // Mobile Control Buttons
        $(document).on('touchend mousedown','#up',function(event) {
            event.preventDefault();
            vibrate();
            pacman.directionWatcher.set(up);
        });
        $(document).on('touchend mousedown','#down',function(event) {
            event.preventDefault();
            vibrate();
            pacman.directionWatcher.set(down);
        });
        $(document).on('touchend mousedown','#left',function(event) {
            event.preventDefault();
            vibrate();
            pacman.directionWatcher.set(left);
        });
        $(document).on('touchend mousedown','#right',function(event) {
            event.preventDefault();
            vibrate();
            pacman.directionWatcher.set(right);
        });

        // Menu
        $(document).on('click','.button#newGame',function(event) {
            game.newGame();
        });
        $(document).on('click','.button#restartLevel',function(event) {
            game.restartLevel();
        });
        $(document).on('click','.button#highscore',function(event) {
            game.showContent('highscore-content');
            getHighscore();
        });
        $(document).on('click','.button#livestats',function(event) {
            game.showContent('livestats-content');
            game.user.livestats = true;
            getLiveStats();
        });
        $(document).on('click','.button#instructions',function(event) {
            game.showContent('instructions-content');
        });
        $(document).on('click','.button#settings',function(event) {
            game.showContent('settings-content');
            renderSettingsForm();
        });
        $(document).on('click','.button#settings-save',function(event) {
            var ebeeEnabled = $('#ebeeMode').is(':checked');
            var mode = $('input[name="maxLevelMode"]:checked').val();
            var value;
            if (mode === 'server') {
                value = null;
            } else if (mode === 'unlimited') {
                value = 'unlimited';
            } else {
                var n = parseInt($('#maxLevelCustom').val(), 10);
                if (!Number.isInteger(n) || n < 1 || n > 999) {
                    $('#settings-status').text('Please enter a whole number between 1 and 999.');
                    return;
                }
                value = n;
            }

            // Ask the server to validate / authorise each change before we
            // persist local overrides. Gameplay and eBee mode have separate
            // server locks, so one can be editable while the other is fixed.
            var payload = {};
            if (game.allowClientOverride) {
                payload.maxLevel = (value === null) ? game.serverMaxLevel : value;
            }
            if (game.allowEbeeModeOverride) {
                payload.ebeeMode = ebeeEnabled;
            }

            if (!Object.keys(payload).length) {
                $('#settings-status').text('This server controls gameplay config and eBee mode.');
                return;
            }

            $.ajax({
                type: 'POST',
                url: 'config',
                data: payload,
                success: function () {
                    if (game.allowClientOverride) {
                        writeUserMaxLevelOverride(value);
                        applyMaxLevel();
                    }
                    if (game.allowEbeeModeOverride) {
                        writeEbeeMode(ebeeEnabled);
                        applyEbeeMode();
                    }
                    var effective = (game.maxLevel === 'unlimited') ? 'unlimited' : game.maxLevel;
                    $('#settings-status').text('Saved. Max level is now ' + effective + '. eBee mode is ' + (game.ebeeMode ? 'on' : 'off') + '.');
                },
                error: function (xhr) {
                    var msg = 'Server rejected the change.';
                    try {
                        var body = xhr.responseJSON || JSON.parse(xhr.responseText);
                        if (body && body.error) msg = 'Server: ' + body.error;
                    } catch (e) { /* keep default */ }
                    if (xhr.status === 403) {
                        fetchServerConfig();
                        renderSettingsForm();
                    }
                    $('#settings-status').text(msg);
                }
            });
        });
        $(document).on('click','.button#settings-reset',function(event) {
            writeUserMaxLevelOverride(null);
            writeEbeeMode(false);
            applyEbeeMode();
            applyMaxLevel();
            renderSettingsForm();
            $('#settings-status').text('Reset to server default.');
        });
        $(document).on('click','.button#info',function(event) {
            game.showContent('info-content');
        });
        // back button
        $(document).on('click','.button#back',function(event) {
            game.showContent('game-content');
            if (game.user.livestats)
                game.user.livestats = false;
        });
        // toggleSound
        $(document).on('click','.controlSound',function(event) {
            game.toggleSound();
        });
        // get latest
        $(document).on('click', '#updateCode', function(event) {
            console.log('check for new version');
            event.preventDefault();
            window.applicationCache.update();
        });

        // checkAppCache();

        canvas = $("#myCanvas").get(0);
        context = canvas.getContext("2d");



        /* --------------- GAME INITIALIZATION ------------------------------------

            TODO: put this into Game object and change code to accept different setups / levels

        -------------------------------------------------------------------------- */

        game.init(0);
        logger.disableLogger();

        renderContent();
        });

        function renderContent()
        {
            //context.save()

            // Refresh Score
            game.score.refresh(".score");

            // Refresh Timer
            game.timer.refresh(".time");

            // Check database update interval
            if (game.user.id) {
                game.user.checkUpdateStats();
            }

            // Pills
            context.beginPath();
            context.fillStyle = "White";
            context.strokeStyle = "White";

            var dotPosY;
            $.each(game.map.posY, function(i, item) {
                dotPosY = this.row;
               $.each(this.posX, function() {
                   if (this.type == "pill") {
                    var pillX = game.toPixelPos(this.col-1)+pacman.radius;
                    var pillY = game.toPixelPos(dotPosY-1)+pacman.radius;
                    context.arc(pillX,pillY,game.pillSize,0*Math.PI,2*Math.PI);
                    context.moveTo(game.toPixelPos(this.col-1), game.toPixelPos(dotPosY-1));
                   }
                   else if (this.type == "powerpill") {
                    var powerPillX = game.toPixelPos(this.col-1)+pacman.radius;
                    var powerPillY = game.toPixelPos(dotPosY-1)+pacman.radius;
                    if (game.ebeeMode) {
                        drawCiliumPill(context, powerPillX, powerPillY, 18);
                    } else {
                        context.arc(powerPillX,powerPillY,game.powerpillSizeCurrent,0*Math.PI,2*Math.PI);
                        context.moveTo(game.toPixelPos(this.col-1), game.toPixelPos(dotPosY-1));
                    }
                   }
               });
            });
            console.log("pps: " + game.nextPowerPillSize());
            context.fill();

            // Walls
            context.drawImage(canvas_walls, 0, 0);


            if (game.running == true) {
                // Ghosts
                pinky.draw(context);
                blinky.draw(context);
                inky.draw(context);
                clyde.draw(context);


                // Pac Man
                if (game.ebeeMode) {
                    drawEbee(context, pacman);
                } else {
                    context.beginPath();
                    context.fillStyle = "Yellow";
                    context.strokeStyle = "Yellow";
                    context.arc(pacman.posX+pacman.radius,pacman.posY+pacman.radius,pacman.radius,pacman.angle1*Math.PI,pacman.angle2*Math.PI);
                    context.lineTo(pacman.posX+pacman.radius, pacman.posY+pacman.radius);
                    context.stroke();
                    context.fill();
                }
            }

        }

        function renderGrid(gridPixelSize, color)
        {
            context.save();
            context.lineWidth = 0.5;
            context.strokeStyle = color;

            // horizontal grid lines
            for(var i = 0; i <= canvas.height; i = i + gridPixelSize)
            {
                context.beginPath();
                context.moveTo(0, i);
                context.lineTo(canvas.width, i);
                context.closePath();
                context.stroke();
            }

            // vertical grid lines
            for(var i = 0; i <= canvas.width; i = i + gridPixelSize)
            {
                context.beginPath();
                context.moveTo(i, 0);
                context.lineTo(i, canvas.height);
                context.closePath();
                context.stroke();
            }

            context.restore();
        }

        function animationLoop()
        {
            canvas.width = canvas.width;
            //renderGrid(pacman.radius, "red");
            renderContent();

            if (game.dieAnimation == 1) pacman.dieAnimation();
            if (game.pause != true){
                // Make changes before next loop
                pacman.move();
                pacman.eat();
                pacman.checkDirectionChange();
                pacman.checkCollisions();        // has to be the LAST method called on pacman



                blinky.move();
                inky.move();
                pinky.move();
                clyde.move();

                game.checkGhostMode();
            }

            // All dots collected?
            game.check();

            //requestAnimationFrame(animationLoop);
            setTimeout(animationLoop, game.refreshRate);
        }



    function doKeyDown(evt){

        switch (evt.keyCode)
            {
            case 38:    // UP Arrow Key pressed
                evt.preventDefault();
            case 87:    // W pressed
                pacman.directionWatcher.set(up);
                break;
            case 40:    // DOWN Arrow Key pressed
                evt.preventDefault();
            case 83:    // S pressed
                pacman.directionWatcher.set(down);
                break;
            case 37:    // LEFT Arrow Key pressed
                evt.preventDefault();
            case 65:    // A pressed
                pacman.directionWatcher.set(left);
                break;
            case 39:    // RIGHT Arrow Key pressed
                evt.preventDefault();
            case 68:    // D pressed
                pacman.directionWatcher.set(right);
                break;
            case 78:    // N pressed
            if (!$('#playerName').is(':focus')) {
                game.pause = 1;
                game.newGame();
                }
                break;
            case 82:    // R pressed
            if (!$('#playerName').is(':focus')) {
                game.pause = 1;
                game.restartLevel();
                }
                break;
            case 77:    // M pressed
                game.toggleSound();
                break;
            case 8:        // Backspace pressed -> show Game Content
            case 27:    // ESC pressed -> show Game Content
                if (!$('#playerName').is(':focus')) {
                    evt.preventDefault();
                    game.showContent('game-content');
                    }
                break;
            case 32:    // SPACE pressed -> pause Game
                evt.preventDefault();
                if (!(game.gameOver == true)
                    && $('#game-content').is(':visible')
                    )    game.pauseResume();
                break;
            }
        }
}

geronimo();
