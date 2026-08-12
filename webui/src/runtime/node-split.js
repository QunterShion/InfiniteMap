/**
 * Coordinates node-split requests with the VS Code extension host.
 * The source subtree is removed only after a correlated success response.
 */
define(function(require, exports, module) {
    var REQUEST_TIMEOUT_MS = 300000;

    function NodeSplitRuntime() {
        var editor = this;
        var minder = this.minder;
        var hotbox = this.hotbox;
        var lang = this.lang.t;
        var requestSequence = 0;
        var pendingRequest = null;

        function report(key) {
            window.vscode.postMessage({
                command: 'errormsg',
				protocolVersion: window.infiniteMapProtocolVersion,
                content: lang(key, 'runtime/nodeSplit')
            });
        }

        function request(node) {
            if (pendingRequest || !node || minder.getSelectedNodes().length !== 1) {
                return false;
            }

            var nodeId = node.getData('id');
            if (!nodeId) {
                report('missingid');
                return false;
            }

            var splitMap = minder.exportJson();
            splitMap.root = minder.exportNode(node);
            var subtreeSnapshot = JSON.stringify(splitMap.root);
            var requestId = window.infiniteMapWebviewSessionId + '-split-' + (++requestSequence);

            pendingRequest = {
                id: requestId,
                nodeId: nodeId,
                isRoot: node.isRoot(),
                node: node,
                subtreeSnapshot: subtreeSnapshot,
                timer: window.setTimeout(function() {
                    if (pendingRequest && pendingRequest.id === requestId) {
                        pendingRequest = null;
                        report('timeout');
                    }
                }, REQUEST_TIMEOUT_MS)
            };
            window.vscode.postMessage({
                command: 'splitNode',
				protocolVersion: window.infiniteMapProtocolVersion,
                requestId: requestId,
                nodeText: node.getText(),
                isRoot: node.isRoot(),
                content: JSON.stringify(splitMap, null, 4)
            });
            return true;
        }

        function handleResult(message) {
            if (!pendingRequest || message.requestId !== pendingRequest.id) {
                return;
            }

            var completed = pendingRequest;
            pendingRequest = null;
            window.clearTimeout(completed.timer);
            if (!message.ok) {
                if (!message.cancelled) {
                    report('failed');
                }
                return;
            }
            if (completed.isRoot) {
                return;
            }

            var currentNode = minder.getNodeById(completed.nodeId);
            if (!currentNode || currentNode !== completed.node || currentNode.isRoot()) {
                report('changed');
                return;
            }
            if (JSON.stringify(minder.exportNode(currentNode)) !== completed.subtreeSnapshot) {
                report('changed');
                return;
            }

            minder.select(currentNode, true);
            minder.execCommand('RemoveNode');
        }

        window.addEventListener('message', function(event) {
            if (event.data && event.data.protocolVersion === window.infiniteMapProtocolVersion && event.data.command === 'splitNodeResult') {
                handleResult(event.data);
            }
        });

        hotbox.state('main').button({
            position: 'bottom',
            label: lang('label', 'runtime/nodeSplit'),
            key: 'Alt + S',
            enable: function() {
                return !pendingRequest && minder.getSelectedNodes().length === 1;
            },
            action: function() {
                minder.fire('splitNodeRequest', {
                    node: minder.getSelectedNode()
                });
            },
            next: 'idle'
        });

        editor.nodeSplit = {
            request: request
        };
    }

    return module.exports = NodeSplitRuntime;
});
