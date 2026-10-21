import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const browserSource = readFileSync(new URL('../public/pacman-canvas.js', import.meta.url), 'utf8');
const mapFixture = JSON.parse(
  readFileSync(new URL('../public/data/map.json', import.meta.url), 'utf8'),
);

function sourceBetween(start, end) {
  const startAt = browserSource.indexOf(start);
  const endAt = browserSource.indexOf(end, startAt);
  assert.notEqual(startAt, -1, `expected browser source to contain ${start}`);
  assert.notEqual(endAt, -1, `expected browser source to contain ${end}`);
  return browserSource.slice(startAt, endAt);
}

const gameSource = sourceBetween('    function Timer()', '    game = new Game();');
const ajaxHelpers = [
  sourceBetween('    function ajaxAdd(', '    function ajaxGetCloudMetadata()'),
  sourceBetween('    function ajaxGetUserId(', '    function getCloudMetadata()'),
  sourceBetween('    function updateUserStats()', '    function buildWall('),
].join('\n');
const keyHandlerSource = sourceBetween('    function doKeyDown(evt){', '\n}\n\ngeronimo();');

function makeBrowserGame({ confirmations = [], prompts = [], deferUserIds = false } = {}) {
  const timeoutCallbacks = [];
  const confirmationResults = [...confirmations];
  const promptResults = [...prompts];
  const elements = new Map();
  const statsPosts = [];
  const scorePosts = [];
  const userIdCallbacks = [];
  let animationLoopStarts = 0;
  let userIdRequests = 0;
  let promptCount = 0;

  function getElement(selector) {
    if (!elements.has(selector)) {
      elements.set(selector, { html: '', text: '', value: undefined });
    }
    const state = elements.get(selector);
    const api = {
      get() {
        return { width: 540, height: 390 };
      },
      html(value) {
        if (arguments.length === 0) return state.html;
        state.html = value;
        if (selector === '#canvas-overlay-content #text') {
          elements.set('#highscore-form', { html: '', text: '', value: undefined });
        }
        return api;
      },
      text(value) {
        if (arguments.length === 0) return state.text;
        state.text = value;
        return api;
      },
      css() {
        return 'none';
      },
      fadeIn() {
        return api;
      },
      fadeOut() {
        return api;
      },
      slideToggle() {
        return api;
      },
      val(value) {
        if (arguments.length === 0) return state.value;
        state.value = value;
        return api;
      },
      focus() {
        return api;
      },
      toggle() {
        return api;
      },
      is() {
        return false;
      },
    };
    return api;
  }

  const $ = (selector) => getElement(selector);
  $.each = (items, callback) => items.forEach((item, index) => callback.call(item, index, item));
  $.ajax = (options) => {
    if (options.url === 'data/map.json') {
      options.success(structuredClone(mapFixture));
      return;
    }
    if (options.url.startsWith('user/id?name=')) {
      userIdRequests += 1;
      if (deferUserIds) userIdCallbacks.push(options.success);
      else options.success(`session-${userIdRequests}`);
      return;
    }
    if (options.url === 'user/stats') {
      statsPosts.push(options);
      options.success({ rs: 'success' });
      return;
    }
    if (options.url === 'highscores') {
      scorePosts.push(options);
      options.success({ rs: 'success' });
      return;
    }
    throw new Error(`unexpected browser AJAX request: ${options.type} ${options.url}`);
  };

  const ghost = { reset() {}, start() {} };
  const context = vm.createContext({
    $,
    console: { log() {} },
    Date,
    Image: function Image() {},
    Score: function Score() {
      this.score = 0;
      this.set = (value) => {
        this.score = value;
      };
      this.refresh = () => {};
    },
    mapConfig: 'data/map.json',
    FINAL_LEVEL: 10,
    CILIUM_LOGO_SRC: 'img/cilium.svg',
    KUBERNETES_LOGO_SRC: 'img/kubernetes.svg',
    PILL_POINTS: 10,
    POWERPILL_POINTS: 50,
    GHOST_POINTS: 100,
    HIGHSCORE_ENABLED: true,
    confirm: () => (confirmationResults.length ? confirmationResults.shift() : true),
    window: {
      prompt: () => {
        promptCount += 1;
        return promptResults.length ? promptResults.shift() : null;
      },
    },
    setTimeout: (callback) => {
      timeoutCallbacks.push(callback);
      return timeoutCallbacks.length;
    },
    animationLoop: () => {
      animationLoopStarts += 1;
    },
    pacman: { lives: 3, reset() {} },
    pinky: ghost,
    inky: ghost,
    blinky: ghost,
    clyde: ghost,
  });

  vm.runInContext(
    `${gameSource}\nvar game = new Game();\n${ajaxHelpers}\n${keyHandlerSource}`,
    context,
  );

  return {
    game: vm.runInContext('game', context),
    statsPosts,
    scorePosts,
    get animationLoopStarts() {
      return animationLoopStarts;
    },
    get userIdRequests() {
      return userIdRequests;
    },
    get promptCount() {
      return promptCount;
    },
    completeUserIdRequest(index, id) {
      assert.ok(userIdCallbacks[index], `expected a pending user ID request at index ${index}`);
      userIdCallbacks[index](id);
    },
    get overlayText() {
      return getElement('#canvas-overlay-content #text').html();
    },
    get overlayTitle() {
      return getElement('#canvas-overlay-content #title').text();
    },
    get scoreFeedback() {
      return getElement('#highscore-form').html();
    },
    setPlayerName(value) {
      getElement('#playerName').val(value);
    },
    submitHighscore() {
      vm.runInContext('addHighscore()', context);
    },
    pressNewGameKey() {
      vm.runInContext('doKeyDown({ keyCode: 78 })', context);
    },
    flushTimeouts() {
      while (timeoutCallbacks.length) timeoutCallbacks.shift()();
    },
  };
}

function startInitialSession(browser) {
  browser.game.pauseResume();
  browser.flushTimeouts();
}

for (const state of ['active', 'paused', 'game-over']) {
  test(`New Game replaces the player session from the ${state} state without adding an animation loop`, () => {
    const browser = makeBrowserGame({
      confirmations: [true],
      prompts: ['Original player', 'Replacement player'],
    });
    const { game } = browser;
    startInitialSession(browser);

    if (state === 'paused') {
      game.pause = true;
      game.timer.stop();
    } else if (state === 'game-over') {
      game.endGame(false);
    }

    game.newGame();
    assert.equal(game.running, true);
    assert.equal(game.pause, false);
    assert.equal(game.gameOver, false);
    assert.equal(game.user.name, 'Replacement player');
    assert.equal(game.user.id, 0, 'the new session clears the previous player ID');
    assert.equal(browser.promptCount, 2, 'each new session asks for a player name');
    assert.equal(
      browser.animationLoopStarts,
      1,
      'restarting should keep the existing animation loop',
    );

    browser.flushTimeouts();
    assert.equal(
      browser.userIdRequests,
      2,
      'one ID request should be made for the replacement session',
    );
    assert.equal(game.user.id, 'session-2');

    game.timer.elapsedTime = 10_000;
    game.user.checkUpdateStats();
    assert.equal(browser.statsPosts.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(browser.statsPosts[0].data)), {
      userId: 'session-2',
      name: 'Replacement player',
      cloud: '',
      zone: '',
      host: '',
      score: 0,
      level: 1,
      lives: 3,
      elapsedTime: 10,
    });
  });
}

test('canceling the New Game confirmation leaves the current session intact', () => {
  const browser = makeBrowserGame({ confirmations: [false], prompts: ['Original player'] });
  const { game } = browser;
  startInitialSession(browser);
  game.level = 3;
  game.score.score = 450;
  const previous = {
    id: game.user.id,
    name: game.user.name,
    level: game.level,
    score: game.score.score,
    pause: game.pause,
    gameOver: game.gameOver,
  };

  game.newGame();

  assert.deepEqual(
    {
      id: game.user.id,
      name: game.user.name,
      level: game.level,
      score: game.score.score,
      pause: game.pause,
      gameOver: game.gameOver,
    },
    previous,
  );
  assert.equal(browser.promptCount, 1);
  assert.equal(browser.userIdRequests, 1);
  assert.equal(browser.animationLoopStarts, 1);
});

test('canceling New Game from the N shortcut leaves an active session unpaused', () => {
  const browser = makeBrowserGame({ confirmations: [false], prompts: ['Original player'] });
  const { game } = browser;
  startInitialSession(browser);

  browser.pressNewGameKey();

  assert.equal(game.pause, false);
  assert.equal(game.user.name, 'Original player');
  assert.equal(game.user.id, 'session-1');
  assert.equal(browser.userIdRequests, 1);
  assert.equal(browser.animationLoopStarts, 1);
});

test('canceling the replacement name prompt leaves the current session intact', () => {
  const browser = makeBrowserGame({ confirmations: [true], prompts: ['Original player', null] });
  const { game } = browser;
  startInitialSession(browser);
  game.level = 3;
  game.score.score = 450;
  const previous = {
    id: game.user.id,
    name: game.user.name,
    level: game.level,
    score: game.score.score,
    pause: game.pause,
    gameOver: game.gameOver,
  };

  game.newGame();

  assert.deepEqual(
    {
      id: game.user.id,
      name: game.user.name,
      level: game.level,
      score: game.score.score,
      pause: game.pause,
      gameOver: game.gameOver,
    },
    previous,
  );
  assert.equal(browser.promptCount, 2);
  assert.equal(browser.userIdRequests, 1);
  assert.equal(browser.animationLoopStarts, 1);
});

test('a late user ID response from a same-name prior session cannot replace its successor', () => {
  const browser = makeBrowserGame({
    confirmations: [true],
    prompts: ['Repeat player', 'Repeat player'],
    deferUserIds: true,
  });
  const { game } = browser;
  startInitialSession(browser);
  game.newGame();
  browser.flushTimeouts();

  assert.equal(browser.userIdRequests, 2);
  browser.completeUserIdRequest(1, 'replacement-id');
  browser.completeUserIdRequest(0, 'original-id');

  assert.equal(game.user.name, 'Repeat player');
  assert.equal(game.user.id, 'replacement-id');
  assert.equal(browser.animationLoopStarts, 1);

  game.timer.elapsedTime = 10_000;
  game.user.checkUpdateStats();
  assert.equal(browser.statsPosts.length, 1);
  assert.equal(browser.statsPosts[0].data.userId, 'replacement-id');
  assert.equal(browser.statsPosts[0].data.name, 'Repeat player');
});

test('the final win creates one stable score form and keeps successful feedback across frames', () => {
  const browser = makeBrowserGame();
  const { game } = browser;
  game.running = true;
  game.user.name = 'Original winner';
  game.level = 1;
  game.maxLevel = 1;
  game.pillCount = 0;
  game.score.score = 1040;
  let formCreations = 0;
  const showHighscoreForm = game.showHighscoreForm;
  game.showHighscoreForm = function showHighscoreFormOnce() {
    formCreations += 1;
    return showHighscoreForm.call(this);
  };

  game.check();
  assert.equal(game.gameOver, true);
  assert.equal(game.allLevelsCompleted, true);
  assert.equal(formCreations, 1);
  assert.match(browser.overlayText, /id='highscore-form'/);

  browser.setPlayerName('Edited winner');
  browser.submitHighscore();
  assert.equal(browser.scorePosts.length, 1);
  assert.equal(browser.scorePosts[0].data.name, 'Edited winner');
  assert.match(browser.scoreFeedback, /View Highscore List/);
  const completedFeedback = browser.scoreFeedback;
  const overlayAfterWin = browser.overlayText;

  for (let frame = 0; frame < 3; frame += 1) game.check();

  assert.equal(formCreations, 1, 'later frames must not rebuild the final form');
  assert.equal(browser.overlayText, overlayAfterWin);
  assert.equal(
    browser.scoreFeedback,
    completedFeedback,
    'successful submission feedback must stay visible',
  );
});

test('collecting pills on a nonfinal level still advances to the next level', () => {
  const browser = makeBrowserGame();
  const { game } = browser;
  game.running = true;
  game.level = 1;
  game.maxLevel = 2;
  game.pillCount = 0;

  game.check();

  assert.equal(game.level, 2);
  assert.equal(game.gameOver, false);
  assert.ok(game.pillCount > 0, 'the next level should load its pill count');
  assert.equal(browser.overlayTitle, 'Level 2');
});
