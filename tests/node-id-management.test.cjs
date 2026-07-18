const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const runtimePath = join(__dirname, '..', 'webui/src/runtime/node-id.js');

function loadRuntime() {
    let exported;
    const context = {
        Date,
        Object,
        define(factory) {
            const module = { exports: {} };
            exported = factory(() => {}, module.exports, module) || module.exports;
        },
    };

    vm.runInNewContext(readFileSync(runtimePath, 'utf8'), context, {
        filename: runtimePath,
    });
    return exported;
}

function createNode(id, children = []) {
    let nodeId = id;
    const node = {
        children,
        getData(key) {
            return key === 'id' ? nodeId : undefined;
        },
        preTraverse(callback) {
            callback(node);
            children.forEach((child) => child.preTraverse(callback));
        },
        setData(key, value) {
            if (key === 'id') nodeId = value;
        },
    };
    return node;
}

function createEditor(root) {
    const handlers = {};
    const minder = {
        getRoot() {
            return root;
        },
        on(event, callback) {
            handlers[event] = callback;
        },
    };
    const editor = { minder };
    loadRuntime().call(editor);
    return { editor, handlers };
}

test('repairs duplicate IDs when a document is registered', () => {
    const first = createNode('duplicate');
    const second = createNode('duplicate');
    const root = createNode('root', [first, second]);

    createEditor(root);

    assert.equal(first.getData('id'), 'duplicate');
    assert.notEqual(second.getData('id'), 'duplicate');
    assert.notEqual(second.getData('id'), first.getData('id'));
});

test('assigns fresh IDs after imported copy data overwrites provisional IDs', () => {
    const sourceChild = createNode('source-child');
    const source = createNode('source', [sourceChild]);
    const root = createNode('root', [source]);
    const { editor, handlers } = createEditor(root);
    const pastedChild = createNode('generated-child');
    const pasted = createNode('generated', [pastedChild]);

    handlers.nodecreate({ node: pasted });
    handlers.nodeattach({ node: pasted });
    pasted.setData('id', 'external-source');
    pastedChild.setData('id', 'external-child');
    editor.nodeIdManager.assignFreshSubtree(pasted);

    assert.notEqual(pasted.getData('id'), 'external-source');
    assert.notEqual(pastedChild.getData('id'), 'external-child');
    assert.notEqual(pasted.getData('id'), source.getData('id'));
    assert.notEqual(pastedChild.getData('id'), sourceChild.getData('id'));
    assert.notEqual(pasted.getData('id'), pastedChild.getData('id'));
});

test('preserves IDs when existing nodes are reattached during drag operations', () => {
    const child = createNode('stable-child');
    const root = createNode('root', [child]);
    const { handlers } = createEditor(root);

    handlers.nodeattach({ node: child });

    assert.equal(child.getData('id'), 'stable-child');
});
