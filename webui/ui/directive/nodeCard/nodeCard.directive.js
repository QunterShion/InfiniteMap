/**
 * 右下角的节点信息卡片
 *
 * 点击选中节点时显示节点文本、创建时间等信息；未选中任何节点时隐藏
 */
angular.module('kityminderEditor')
    .directive('nodeCard', function() {
        return {
            restrict: 'A',
            templateUrl: 'ui/directive/nodeCard/nodeCard.html',
            scope: {
                minder: '='
            },
            link: function(scope) {
                var minder = scope.minder;

                scope.visible = false;
                scope.card = {};

                function pad(n) {
                    return n < 10 ? '0' + n : '' + n;
                }

                function formatTime(timestamp) {
                    if (!timestamp) return '—';
                    var d = new Date(timestamp);
                    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
                        + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
                }

                var EXEC_STATE_TEXT = {
                    claimed: '执行中',
                    done: '已完成',
                    released: '已释放',
                    failed: '已失败'
                };

                // 读取旁车执行状态（由扩展端监听 <km>.exec.json 推送）
                function getExecInfo(nodeId) {
                    var tasks = window.kmExecState || {};
                    var entry = tasks[nodeId];
                    if (!entry || !entry.state) return null;

                    var claimed = entry.state === 'claimed';
                    var leaseExpired = claimed &&
                        entry.leaseUntil && Date.parse(entry.leaseUntil) < Date.now();
                    return {
                        stateText: leaseExpired ? '租约过期' : (EXEC_STATE_TEXT[entry.state] || entry.state),
                        workerId: entry.workerId || '—',
                        leaseUntil: claimed && entry.leaseUntil ? formatTime(Date.parse(entry.leaseUntil)) : null,
                        failReason: entry.state === 'failed' ? (entry.failReason || null) : null
                    };
                }

                function refresh() {
                    var nodes = minder.getSelectedNodes();
                    var node = nodes.length ? nodes[nodes.length - 1] : null;

                    if (!node) {
                        scope.visible = false;
                        return;
                    }

                    var data = node.data || {};
                    scope.card = {
                        text: data.text || '',
                        created: formatTime(data.created),
                        nodeId: data.id || '—',
                        level: node.getLevel(),
                        childCount: (node.children || []).length,
                        resources: data.resource || [],
                        exec: getExecInfo(data.id)
                    };
                    scope.visible = true;
                }

                function applyRefresh() {
                    refresh();
                    if (!scope.$$phase && !scope.$root.$$phase) {
                        scope.$apply();
                    }
                }

                minder.on('selectionchange', applyRefresh);

                // 选中状态下节点文本、标签等内容变化时同步刷新卡片
                minder.on('contentchange', function() {
                    if (!scope.visible) return;
                    applyRefresh();
                });

                // 旁车执行状态推送到达时刷新卡片中的执行信息
                document.addEventListener('km-exec-state', function() {
                    if (!scope.visible) return;
                    applyRefresh();
                });

                scope.resourceColor = function(resource) {
                    return minder.getResourceColor(resource).toHEX();
                };
            }
        };
    });
