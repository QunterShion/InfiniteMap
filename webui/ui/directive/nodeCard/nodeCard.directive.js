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
				// Keep every focus level so Return can pop one level at a time.
				var focusStack = [];
				var expandedNodeOverrides = [];
				var pendingCameraHandler = null;
				var pendingCameraTimer = null;

                scope.visible = false;
				scope.focused = false;
				scope.card = {};

				function getFocusedRoot() {
					return focusStack.length ? focusStack[focusStack.length - 1] : null;
				}

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

				function getNodeId(node) {
					return node && node.data && node.data.id;
				}

				// 截断文本，超过 maxLength 个字符时用 ... 替代
				function truncateText(text, maxLength) {
					if (!text || text.length <= maxLength) return text;
					return text.substring(0, maxLength) + '...';
				}

				function getBreadcrumbs(node) {
					var breadcrumbs = [];
					var current = node;
					while (current) {
						var fullText = (current.data && current.data.text) || '—';
						breadcrumbs.unshift({
							nodeId: getNodeId(current) || '',
							text: truncateText(fullText, 8),
							fullText: fullText,  // 保留完整文本用于 tooltip
							isCurrent: current === node
						});
						current = current.getParent ? current.getParent() : current.parent;
					}
					return breadcrumbs;
				}

				function findNode(nodeId) {
					var node = minder.getNodeById && minder.getNodeById(nodeId);
					if (node) return node;

					minder.getRoot().traverse(function(candidate) {
						if (!node && getNodeId(candidate) === nodeId) node = candidate;
					});
					return node;
				}

				function isInFocusedTree(node) {
					var focusedRoot = getFocusedRoot();
					if (!focusedRoot || focusedRoot === node) return true;
					if (!focusedRoot.isAncestorOf(node)) return false;

					// 聚焦模式仍遵循子树的实际展开状态，收缩后隐藏全部后代。
					var current = node;
					while (current && current !== focusedRoot) {
						if (current.parent && !current.parent.isExpanded()) return false;
						current = current.parent;
					}
					return true;
				}

				function updateNodeVisibility(node) {
					var focusedRoot = getFocusedRoot();
					var visible = isInFocusedTree(node);
					var container = node.getRenderContainer && node.getRenderContainer();
					var connection = node.getConnection && node.getConnection();

					if (container && container.setVisible) container.setVisible(visible);
					if (!connection || !connection.setVisible) return;

					if (!visible || node === focusedRoot) {
						connection.setVisible(false);
					} else if (minder.updateConnect) {
						minder.updateConnect(node);
					} else {
						connection.setVisible(true);
					}
				}

				function applyFocusVisibility(event) {
					if (!getFocusedRoot()) return;
					if (event && event.type === 'nodeattach' && event.node) {
						event.node.traverse(overrideExpandedState);
					}
					if (event && event.node) {
						updateNodeVisibility(event.node);
						return;
					}
					minder.getRoot().traverse(updateNodeVisibility);
				}

				function shouldForceExpanded(node) {
					var focusedRoot = getFocusedRoot();
					// 只强制展开从根到聚焦节点的路径，不强制展开聚焦节点的子孙节点
					// 这样聚焦模式下仍可手动收缩/展开子节点
					return focusedRoot && node.isAncestorOf(focusedRoot);
				}

				function overrideExpandedState(node) {
					var alreadyOverridden = expandedNodeOverrides.some(function(entry) {
						return entry.node === node;
					});
					if (alreadyOverridden || !node.isExpanded) return;

					var ownsMethod = Object.prototype.hasOwnProperty.call(node, 'isExpanded');
					var originalMethod = node.isExpanded;
					expandedNodeOverrides.push({
						node: node,
						ownsMethod: ownsMethod,
						method: originalMethod
					});
					node.isExpanded = function() {
						return shouldForceExpanded(node) || originalMethod.call(node);
					};
				}

				function forceFocusedTreeExpanded() {
					minder.getRoot().traverse(overrideExpandedState);
				}

				function restoreExpandedMethods() {
					expandedNodeOverrides.forEach(function(entry) {
						if (entry.ownsMethod) {
							entry.node.isExpanded = entry.method;
						} else {
							delete entry.node.isExpanded;
						}
					});
					expandedNodeOverrides = [];
				}

				function restoreFullMapVisibility() {
					minder.getRoot().traverse(function(node) {
						var visible = !node.parent || node.parent.isExpanded();
						var container = node.getRenderContainer && node.getRenderContainer();
						if (container && container.setVisible) container.setVisible(visible);
						if (minder.updateConnect && node.getConnection && node.getConnection()) {
							minder.updateConnect(node);
						}
					});
				}

				function cancelPendingCamera() {
					if (pendingCameraHandler) {
						minder.off('layoutallfinish', pendingCameraHandler);
						pendingCameraHandler = null;
					}
					if (pendingCameraTimer) {
						window.clearTimeout(pendingCameraTimer);
						pendingCameraTimer = null;
					}
				}

				function centerNodeInCanvas(node) {
					var paper = minder.getPaper && minder.getPaper();
					var dragger = minder.getViewDragger && minder.getViewDragger();
					var container = node && node.getRenderContainer && node.getRenderContainer();
					if (!paper || !dragger || !container || !container.getRenderBox) {
						minder.execCommand('camera', node);
						return;
					}

					var viewport = paper.getViewPort();
					var box = container.getRenderBox('view');
					dragger.move({
						x: viewport.center.x - box.x - box.width / 2,
						y: viewport.center.y - box.y - box.height / 2
					}, 0);
				}

				function centerAfterLayout(node) {
					cancelPendingCamera();
					pendingCameraHandler = function() {
						minder.off('layoutallfinish', pendingCameraHandler);
						pendingCameraHandler = null;
						// Run after layout listeners finish so their view animations cannot replace this camera move.
						pendingCameraTimer = window.setTimeout(function() {
							pendingCameraTimer = null;
							centerNodeInCanvas(node);
							refresh();
						}, 0);
					};
					minder.on('layoutallfinish', pendingCameraHandler);
				}

				function renderFocusedView(centerNode) {
					if (!getFocusedRoot()) return;
					restoreExpandedMethods();
					scope.focused = true;
					forceFocusedTreeExpanded();
					minder.getRoot().renderTree();
					if (centerNode) centerAfterLayout(centerNode);
					minder.layout();
					applyFocusVisibility();
					refresh();
				}

				function clearFocus(centerFullMap) {
					if (!focusStack.length && !scope.focused) return;

					focusStack = [];
					scope.focused = false;
					restoreExpandedMethods();
					minder.getRoot().renderTree();
					if (centerFullMap !== false) centerAfterLayout(minder.getRoot());
					minder.layout();
					restoreFullMapVisibility();
					refresh();
				}

				function leaveFocus() {
					if (!focusStack.length) return;

					focusStack.pop();
					if (focusStack.length) {
						renderFocusedView(getFocusedRoot());
					} else {
						clearFocus(true);
					}
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
                        childCount: (node.children || []).length,
						breadcrumbs: getBreadcrumbs(node),
						isFocused: !!getFocusedRoot(),
						focusDepth: focusStack.length,
						canFocus: (node.children || []).length > 0,
						isCurrentFocus: getFocusedRoot() === node,
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
				function handleContentChange() {
					if (focusStack.some(function(focusedRoot) {
						return !minder.getRoot().contains(focusedRoot);
					})) {
						clearFocus(false);
					}
                    if (!scope.visible) return;
                    applyRefresh();
					applyFocusVisibility();
				}
				minder.on('contentchange', handleContentChange);
				minder.on('nodeattach noderender layoutapply layoutfinish', applyFocusVisibility);

                // 旁车执行状态推送到达时刷新卡片中的执行信息
				function handleExecState() {
                    if (!scope.visible) return;
                    applyRefresh();
				}
				document.addEventListener('km-exec-state', handleExecState);

				function handleExecutionAvailability() {
					if (!scope.visible) return;
					applyRefresh();
				}
				document.addEventListener('km-execution-availability', handleExecutionAvailability);

				scope.focusNode = function() {
					var nodes = minder.getSelectedNodes();
					var node = nodes.length ? nodes[nodes.length - 1] : null;
					if (!node) return;

					if (getFocusedRoot() === node) {
						centerNodeInCanvas(node);
						refresh();
						return;
					}
					focusStack.push(node);
					renderFocusedView(node);
					minder.select(node, true);
					refresh();
				};

				scope.exitFocus = function() {
					leaveFocus();
				};

				scope.centerBreadcrumb = function(nodeId) {
					var node = findNode(nodeId);
					var restoringFocusedMap = focusStack.length > 0;
					if (!node) return;
					if (restoringFocusedMap) {
						clearFocus(false);
						centerAfterLayout(node);
					}
					minder.select(node, true);
					if (!restoringFocusedMap) centerNodeInCanvas(node);
				};

				scope.openHistory = function() {
					if (!scope.card.nodeId || scope.card.nodeId === '—') return;
					document.dispatchEvent(new CustomEvent('agent-session-history-open', {
						detail: {
							nodeId: scope.card.nodeId,
							executionId: scope.card.latestSession && scope.card.latestSession.executionId
						}
					}));
				};

				 scope.$on('$destroy', function() {
					clearFocus(false);
					cancelPendingCamera();
					minder.off('selectionchange', applyRefresh);
					minder.off('contentchange', handleContentChange);
					minder.off('nodeattach noderender layoutapply layoutfinish', applyFocusVisibility);
					document.removeEventListener('km-exec-state', handleExecState);
					document.removeEventListener('km-execution-availability', handleExecutionAvailability);
				});
            }
        };
	}]);
