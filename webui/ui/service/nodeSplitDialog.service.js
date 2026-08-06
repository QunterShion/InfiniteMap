angular.module('kityminderEditor').service('nodeSplitDialog', ['$uibModal', 'minder.service', function($modal, minderService) {
    minderService.registerEvent(function() {
        var minder = window.minder;
        var editor = window.editor;
        var parentFSM = editor.hotbox.getParentFSM();

        minder.on('splitNodeRequest', function(event) {
            var node = event.node;
            if (!node || minder.getSelectedNodes().length !== 1) {
                return;
            }

            parentFSM.jump('modal', 'split-node-modal');
            var modal = $modal.open({
                animation: true,
                backdrop: 'static',
                keyboard: true,
                templateUrl: 'ui/dialog/nodeSplit/nodeSplit.tpl.html',
                controller: 'nodeSplit.ctrl',
                size: 'md',
                windowClass: 'split-node-dialog-window',
                resolve: {
                    isRoot: function() {
                        return node.isRoot();
                    },
                    nodeText: function() {
                        return node.getText();
                    }
                }
            });

            modal.opened.then(function() {
                window.setTimeout(function() {
                    var dialog = document.querySelector('.split-node-dialog-window[role="dialog"]');
                    if (dialog) {
                        dialog.setAttribute('aria-labelledby', 'split-node-dialog-title');
                        dialog.setAttribute('aria-describedby', 'split-node-dialog-description');
                        dialog.setAttribute('aria-modal', 'true');
                    }
                }, 0);
            });

            modal.result.then(function() {
                editor.nodeSplit.request(node);
                parentFSM.jump('normal', 'split-node-confirmed');
                editor.receiver.selectAll();
            }, function() {
                parentFSM.jump('normal', 'split-node-cancelled');
                editor.receiver.selectAll();
            });
        });
    });

    return {};
}]);
