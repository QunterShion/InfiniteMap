const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = join(__dirname, '..');

function loadDirective(relativePath, targetName, contextOverrides = {}) {
    let directiveFactory;
    const angularModule = {
        directive(name, factory) {
            if (name === targetName) {
                directiveFactory = factory;
            }
            return angularModule;
        },
    };
    const context = {
        angular: {
            module() {
                return angularModule;
            },
        },
        clearTimeout,
        console,
        setTimeout,
        window: {},
        ...contextOverrides,
    };

    vm.runInNewContext(readFileSync(join(root, relativePath), 'utf8'), context, {
        filename: relativePath,
    });

    assert.ok(directiveFactory, `Expected ${targetName} directive to be registered`);
    return { context, directiveFactory };
}

function unwrapFactory(factory) {
    return Array.isArray(factory) ? factory[factory.length - 1] : factory;
}

test('modifier wheel zoom follows the native macOS direction', async () => {
    const handlers = {};
    const commands = [];
    const minder = {
        execCommand(command) {
            commands.push(command);
        },
        on(event, handler) {
            handlers[event] = handler;
        },
    };
    const Editor = function() {
        this.minder = minder;
    };
    const kityminder = { Editor };
    const { directiveFactory } = loadDirective(
        'webui/ui/directive/kityminderEditor/kityminderEditor.directive.js',
        'kityminderEditor',
        { kityminder, window: { kityminder } },
    );
    const factory = unwrapFactory(directiveFactory);
    const directive = factory(
        { get: () => 'en' },
        { executeCallback() {} },
        {},
    );
    const scope = {
        onInit() {},
    };

    directive.link(scope, { children: () => [{}] }, {});
    assert.equal(typeof handlers.premousewheel, 'function');

    let prevented = 0;
    let stopped = 0;
    handlers.premousewheel({
        originEvent: {
            ctrlKey: true,
            metaKey: false,
            preventDefault() {
                prevented++;
            },
            wheelDelta: 120,
        },
        stopPropagation() {
            stopped++;
        },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    handlers.premousewheel({
        originEvent: {
            ctrlKey: false,
            metaKey: true,
            preventDefault() {
                prevented++;
            },
            wheelDelta: -120,
        },
        stopPropagation() {
            stopped++;
        },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.deepEqual(commands, ['zoomin', 'zoomout']);
    assert.equal(prevented, 2);
    assert.equal(stopped, 2);
});

test('resource editor always exposes built-in completion tags without mutating selection', () => {
    let watchCallback;
    const commands = [];
    const minder = {
        execCommand(command, value) {
            commands.push([command, value]);
        },
        getResourceColor() {
            return { toHEX: () => '#000000' };
        },
        getUsedResource() {
            return ['existing'];
        },
        on() {},
        queryCommandState() {
            return 0;
        },
        queryCommandValue() {
            return ['existing'];
        },
    };
    const { directiveFactory } = loadDirective(
        'webui/ui/directive/resourceEditor/resourceEditor.directive.js',
        'resourceEditor',
    );
    const directive = unwrapFactory(directiveFactory)();
    const scope = {
        minder,
        $watch(name, callback) {
            assert.equal(name, 'used');
            watchCallback = callback;
        },
    };

    directive.controller(scope);
    assert.deepEqual(
        Array.from(scope.used, (resource) => resource.name),
        ['existing', '已完成', '待拆解', '待协同'],
    );
    assert.equal(scope.used[0].selected, true);

    watchCallback(scope.used);
    assert.deepEqual(commands, []);
});

test('replace all updates node text and notes case-insensitively in one change', () => {
    const events = {};
    const nodes = [
        createNode('Alpha alpha', 'note alpha'),
        createNode('untouched', ''),
    ];
    let layoutCount = 0;
    let contentChangeCount = 0;
    const minder = {
        execCommand() {},
        fire(event) {
            if (event === 'contentchange') {
                contentChangeCount++;
                if (events[event]) events[event]();
            }
        },
        getRoot() {
            return {
                traverse(callback) {
                    nodes.forEach(callback);
                },
            };
        },
        layout() {
            layoutCount++;
        },
        on(event, callback) {
            events[event] = callback;
        },
    };
    const jquery = () => ({
        0: { setSelectionRange() {} },
        blur() {},
        focus() {},
        off() {},
        on() {},
    });
    const { directiveFactory } = loadDirective(
        'webui/ui/directive/searchBox/searchBox.directive.js',
        'searchBox',
        {
            $: jquery,
            window: { editor: { receiver: { selectAll() {} } } },
        },
    );
    const directive = unwrapFactory(directiveFactory)();
    const scope = {
        minder,
        $on() {},
    };

    directive.controller(scope);
    scope.keyword = 'alpha';
    scope.replacement = 'omega';
    scope.doReplace(true);

    assert.equal(nodes[0].getText(), 'omega omega');
    assert.equal(nodes[0].getData('note'), 'note omega');
    assert.equal(nodes[1].getText(), 'untouched');
    assert.equal(scope.replaceCount, 3);
    assert.equal(layoutCount, 1);
    assert.equal(contentChangeCount, 1);
    assert.equal(nodes[0].renderCount, 1);
    assert.equal(nodes[1].renderCount, 0);
});

function createNode(text, note) {
    return {
        renderCount: 0,
        getData(key) {
            return key === 'note' ? note : undefined;
        },
        getText() {
            return text;
        },
        render() {
            this.renderCount++;
        },
        setData(key, value) {
            if (key === 'note') note = value;
        },
        setText(value) {
            text = value;
        },
    };
}
