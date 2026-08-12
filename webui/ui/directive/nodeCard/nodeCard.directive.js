/**
 * 右下角的节点信息卡片
 *
 * 点击选中节点时显示节点文本、创建时间等信息；未选中任何节点时隐藏
 */
angular.module('kityminderEditor')
    .directive('nodeCard', ['agentSessionI18n', function(agentSessionI18n) {
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
					claimed: 'claimed',
					done: 'done',
					released: 'released',
					failed: 'failedState'
                };

				var TASK_LABELS = ['待拆解', '待协同', '已完成'];

                // 读取旁车执行状态（由扩展端监听 <km>.exec.json 推送）
                function getExecInfo(nodeId) {
                    var tasks = window.kmExecState || {};
                    var entry = tasks[nodeId];
                    if (!entry || !entry.state) return null;

                    var claimed = entry.state === 'claimed';
                    var leaseExpired = claimed &&
                        entry.leaseUntil && Date.parse(entry.leaseUntil) < Date.now();
                    return {
						stateText: leaseExpired
							? agentSessionI18n.t('leaseExpired')
							: agentSessionI18n.t(EXEC_STATE_TEXT[entry.state] || entry.state),
                        workerId: entry.workerId || '—',
                        leaseUntil: claimed && entry.leaseUntil ? formatTime(Date.parse(entry.leaseUntil)) : null,
                        failReason: entry.state === 'failed' ? (entry.failReason || null) : null
                    };
                }

				function getTaskInfo(resources, nodeId) {
					var taskLabels = (resources || []).filter(function(resource) {
						return TASK_LABELS.indexOf(resource) >= 0;
					});
					var availability = window.kmExecutionAvailability;
					var exec = getExecInfo(nodeId);
					var stateText = exec && exec.stateText;
					if (!stateText && taskLabels.indexOf('已完成') >= 0) {
						stateText = agentSessionI18n.t('done');
					} else if (!stateText && taskLabels.length > 0) {
						stateText = agentSessionI18n.t('pending');
					}
					if (availability && availability.available === false) {
						stateText = agentSessionI18n.t(
							availability.state === 'connecting' || availability.state === 'reconnecting'
								? 'mcpReconnecting'
								: 'kmUnavailable'
						);
					}
					return {
						labels: taskLabels,
						stateText: stateText || agentSessionI18n.t('nonTask'),
						unavailableReason: availability && availability.available === false
							? availability.reason
							: null,
						exec: exec
					};
				}

				function getSessionInfo(data) {
					var state = data.infiniteMap || {};
					var latest = state.latestSession;
					if (!latest) return { latest: null, historyCount: state.sessionHistoryCount || 0 };
					return {
						latest: {
							executionId: latest.executionId,
							provider: latest.provider || '—',
							modelId: latest.modelId || agentSessionI18n.t('defaultModel'),
							effort: latest.effort || null,
							status: latest.status || '—',
							updatedAt: formatTime(Date.parse(latest.updatedAt)),
							sessionId: latest.sessionId
						},
						historyCount: state.sessionHistoryCount || 1
					};
				}

                function refresh() {
                    var nodes = minder.getSelectedNodes();
                    var node = nodes.length ? nodes[nodes.length - 1] : null;

                    if (!node) {
						window.infiniteMapSelectedNodeId = null;
                        scope.visible = false;
                        return;
                    }

                    var data = node.data || {};
					window.infiniteMapSelectedNodeId = data.id || null;
					var resources = data.resource || [];
					var task = getTaskInfo(resources, data.id);
					var session = getSessionInfo(data);
                    scope.card = {
                        text: data.text || '',
                        created: formatTime(data.created),
                        nodeId: data.id || '—',
                        level: node.getLevel(),
                        childCount: (node.children || []).length,
						resources: resources,
						task: task,
						exec: task.exec,
						latestSession: session.latest,
						historyCount: session.historyCount
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

				document.addEventListener('km-execution-availability', function() {
					if (!scope.visible) return;
					applyRefresh();
				});
				scope.openHistory = function() {
					if (!scope.card.nodeId || scope.card.nodeId === '—') return;
					document.dispatchEvent(new CustomEvent('agent-session-history-open', {
						detail: {
							nodeId: scope.card.nodeId,
							executionId: scope.card.latestSession && scope.card.latestSession.executionId
						}
					}));
				};
            }
        };
	}]);
