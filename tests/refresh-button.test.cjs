const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createHarness() {
  const state = {
    group: null,
    messages: [],
    messageListeners: [],
    styles: [],
    timers: new Map(),
    nextTimerId: 1,
  };
  const document = {
    getElementById(id) {
      return state.styles.find((style) => style.id === id);
    },
  };

  class Collection {
    constructor(elements) {
      this.elements = elements;
      this.length = elements.length;
    }

    append(collection) {
      for (const element of this.elements) {
        element.children.push(...collection.elements);
      }
      return this;
    }

    appendTo(target) {
      if (target === 'head') state.styles.push(...this.elements);
      return this;
    }

    attr(name, value) {
      for (const element of this.elements) element.attrs[name] = value;
      return this;
    }

    find(selector) {
      if (selector !== '.refresh-from-disk-btn') return new Collection([]);
      return new Collection(this.elements.flatMap((element) =>
        (element.children || []).filter((child) => child.type === 'refresh-button')
      ));
    }

    on(event, handler) {
      for (const element of this.elements) element.handlers[event] = handler;
      return this;
    }

    ready(handler) {
      handler();
      return this;
    }

    removeAttr(name) {
      for (const element of this.elements) delete element.attrs[name];
      return this;
    }

    text(value) {
      for (const element of this.elements) element.text = value;
      return this;
    }
  }

  function jquery(value) {
    if (value === document) return new Collection([{ type: 'document' }]);
    if (value === '.do-group') return new Collection(state.group ? [state.group] : []);
    if (value === '.refresh-from-disk-btn') {
      return new Collection(state.group
        ? state.group.children.filter((child) => child.type === 'refresh-button')
        : []);
    }
    if (typeof value === 'string' && value.startsWith('<style')) {
      return new Collection([{ attrs: {}, id: 'infinite-map-refresh-style', text: '', type: 'style' }]);
    }
    if (typeof value === 'string' && value.startsWith('<div')) {
      return new Collection([{ attrs: {}, handlers: {}, html: value, type: 'refresh-button' }]);
    }
    return new Collection([]);
  }

  function scheduleTimer(handler, delay) {
    const id = state.nextTimerId++;
    state.timers.set(id, { delay, handler });
    return id;
  }

  const window = {
    infiniteMapWebviewSessionId: 'webview-session',
    addEventListener(name, handler) {
      if (name === 'message') state.messageListeners.push(handler);
    },
    clearTimeout(id) {
      state.timers.delete(id);
    },
    setTimeout: scheduleTimer,
    vscode: {
      postMessage(message) {
        state.messages.push(message);
        return undefined;
      },
    },
  };
  const source = fs.readFileSync(path.resolve(__dirname, '../webui/refreshBtn.js'), 'utf8');
  vm.runInNewContext(source, {
    console,
    document,
    setTimeout: scheduleTimer,
    window,
    $: jquery,
  });

  return {
    addToolbar() {
      state.group = { children: [], type: 'group' };
    },
    dispatchMessage(message) {
      for (const listener of state.messageListeners) listener({ data: message });
    },
    get button() {
      return state.group?.children[0];
    },
    runNextTimer() {
      const entry = state.timers.entries().next().value;
      if (!entry) return;
      const [id, timer] = entry;
      state.timers.delete(id);
      timer.handler();
    },
    state,
    window,
  };
}

test('refresh control matches Mind Map and waits for an explicit result', () => {
  const harness = createHarness();

  assert.equal(harness.button, undefined);
  assert.equal(harness.state.timers.size, 1);

  harness.addToolbar();
  harness.runNextTimer();

  const button = harness.button;
  assert.ok(button);
  assert.match(button.html, /class="km-btn-item refresh-from-disk-btn"/);
  assert.match(button.html, /aria-label="从磁盘刷新 \(Refresh from Disk\)"/);
  assert.match(button.html, /class="mindmap-refresh-icon" viewBox="0 0 24 24"/);
  assert.match(button.html, /M21 12a9 9 0 0 1-15\.5 6\.2L3 15/);
  assert.match(button.html, /M3 12a9 9 0 0 1 15\.5-6\.2L21 9/);
  assert.doesNotMatch(button.html, /km-btn-caption/);
  assert.equal(harness.state.styles.length, 1);
  assert.match(harness.state.styles[0].text, /width:16px;height:16px;margin:2px;stroke:currentColor/);

  const click = { preventDefault: () => undefined };
  button.handlers.click(click);
  button.handlers.click(click);

  assert.equal(harness.state.messages.length, 1);
  assert.equal(harness.state.messages[0].command, 'refresh');
  assert.equal(harness.state.messages[0].requestId, 'webview-session:refresh:1');
  assert.equal(button.attrs['aria-disabled'], 'true');
  assert.equal(button.attrs['aria-busy'], 'true');
  assert.equal(harness.window.mindmapSuppressDraft, true);

  harness.dispatchMessage({
    command: 'refreshResult',
    requestId: harness.state.messages[0].requestId,
    ok: true,
  });
  assert.equal(button.attrs['aria-disabled'], undefined);
  assert.equal(button.attrs['aria-busy'], undefined);
  assert.equal(harness.window.mindmapSuppressDraft, false);

  button.handlers.keydown({ key: 'Enter', preventDefault: () => undefined });
  assert.equal(harness.state.messages.length, 2);
  assert.equal(harness.state.messages[1].requestId, 'webview-session:refresh:2');
});
