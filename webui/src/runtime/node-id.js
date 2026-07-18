/**
 * Keeps node IDs unique while preserving IDs for in-place tree moves.
 */
define(function(require, exports, module) {

    function NodeIdRuntime() {
        var minder = this.minder;
        var owners = Object.create(null);
        var lastTimestamp = 0;
        var sequence = 0;

        function nextCandidate() {
            var timestamp = +new Date();
            if (timestamp === lastTimestamp) {
                sequence++;
            } else {
                lastTimestamp = timestamp;
                sequence = 0;
            }
            return 'n' + timestamp.toString(36) + sequence.toString(36);
        }

        function allocate(node) {
            var id;
            do {
                id = nextCandidate();
            } while (owners[id]);

            node.setData('id', id);
            node._managedNodeId = id;
            owners[id] = node;
            return id;
        }

        function ensureNode(node) {
            var id = node.getData('id');
            var previousId = node._managedNodeId;

            if (previousId && previousId !== id && owners[previousId] === node) {
                delete owners[previousId];
            }

            if (!id || (owners[id] && owners[id] !== node)) {
                return allocate(node);
            }

            node._managedNodeId = id;
            owners[id] = node;
            return id;
        }

        function ensureSubtree(node) {
            node.preTraverse(ensureNode);
            return node;
        }

        function assignFreshSubtree(node) {
            node.preTraverse(function(current) {
                var previousId = current._managedNodeId;
                if (previousId && owners[previousId] === current) {
                    delete owners[previousId];
                }
                allocate(current);
            });
            return node;
        }

        function releaseSubtree(node) {
            node.preTraverse(function(current) {
                var id = current._managedNodeId || current.getData('id');
                if (id && owners[id] === current) {
                    delete owners[id];
                }
            });
        }

        function rebuild() {
            owners = Object.create(null);
            ensureSubtree(minder.getRoot());
        }

        this.nodeIdManager = {
            assignFreshSubtree: assignFreshSubtree,
            ensureNode: ensureNode,
            ensureSubtree: ensureSubtree,
            rebuild: rebuild
        };

        rebuild();
        minder.on('nodecreate', function(e) {
            ensureNode(e.node);
        });
        minder.on('nodeattach', function(e) {
            ensureSubtree(e.node);
        });
        minder.on('noderemove', function(e) {
            releaseSubtree(e.node);
        });
        minder.on('import', rebuild);
    }

    return module.exports = NodeIdRuntime;
});
