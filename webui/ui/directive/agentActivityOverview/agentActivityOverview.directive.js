angular.module('kityminderEditor').directive('agentActivityOverview', [
	'agentSessionService',
	function(agentSessionService) {
		return {
			restrict: 'A',
			templateUrl: 'ui/directive/agentActivityOverview/agentActivityOverview.html',
			link: function(scope) {
				var ACTIVE_STATUSES = {
					allocated: true,
					starting: true,
					running: true,
					interrupting: true,
					disconnected: true
				};
				var refreshTimer = null;
				scope.activity = { visible: false, loading: false, items: [], total: 0, error: null };

				function nodeTitle(nodeId) {
					var title = nodeId;
					if (!window.minder || !window.minder.getRoot) return title;
					window.minder.getRoot().traverse(function(node) {
						if (node.getData('id') === nodeId) title = node.getText() || nodeId;
					});
					return title;
				}

				function merge(sessions) {
					var byNode = {};
					(sessions || []).filter(function(session) {
						return ACTIVE_STATUSES[session.status] === true;
					}).forEach(function(session) {
						var item = {
							nodeId: session.nodeId,
							nodeTitle: nodeTitle(session.nodeId),
							executionId: session.executionId,
							status: session.status,
							provider: session.session && session.session.provider,
							modelId: session.session && session.session.modelId,
							updatedAt: session.updatedAt,
							session: session
						};
						byNode[session.nodeId + ':' + session.executionId] = item;
					});
				var now = Date.now();
				Object.keys(window.kmExecState || {}).forEach(function(nodeId) {
					var lease = window.kmExecState[nodeId];
					if (!lease || lease.state !== 'claimed' || Date.parse(lease.leaseUntil) <= now) return;
					var matchingKey = Object.keys(byNode).find(function(key) {
						return byNode[key].nodeId === nodeId;
					});
					var item = matchingKey ? byNode[matchingKey] : {
						nodeId: nodeId,
						nodeTitle: nodeTitle(nodeId),
						status: 'claimed'
					};
					item.workerId = lease.workerId;
					item.leaseUntil = lease.leaseUntil;
					item.taskKind = lease.taskKind || 'todo';
					if (!matchingKey) byNode[nodeId + ':lease'] = item;
				});
				scope.activity.items = Object.keys(byNode).map(function(key) { return byNode[key]; }).sort(function(left, right) {
					return Date.parse(right.updatedAt || right.leaseUntil || 0) - Date.parse(left.updatedAt || left.leaseUntil || 0);
				});
				scope.activity.total = scope.activity.items.length;
			}

				function load(cursor, sessions) {
					agentSessionService.queryActivityPage(cursor, 100).then(function(page) {
						var collected = sessions.concat(page.sessions || []);
						if (page.nextCursor) {
							load(page.nextCursor, collected);
							return;
						}
						scope.activity.loading = false;
						scope.activity.error = null;
						merge(collected);
					}, function(error) {
						scope.activity.loading = false;
						scope.activity.error = error && error.message || String(error);
					});
				}

				function refresh() {
					if (!scope.activity.visible) return;
					scope.activity.loading = true;
					load(null, []);
				}

				function scheduleRefresh() {
					if (!scope.activity.visible) return;
					if (refreshTimer) window.clearTimeout(refreshTimer);
					refreshTimer = window.setTimeout(function() {
						refreshTimer = null;
						refresh();
					}, 60);
				}

				function open() {
					scope.activity.visible = true;
					refresh();
					if (!scope.$$phase && !scope.$root.$$phase) scope.$apply();
				}

				document.addEventListener('agent-activity-open', open);
				document.addEventListener('km-exec-state', scheduleRefresh);
				scope.$on('agent-session-event', scheduleRefresh);
				scope.$on('mcp-connection-state', function(_event, connection) {
					if (connection.state === 'ready') scheduleRefresh();
				});
				scope.closeAgentActivity = function() { scope.activity.visible = false; };
				scope.openActivityHistory = function(item) {
					document.dispatchEvent(new CustomEvent('agent-session-history-open', {
						detail: { nodeId: item.nodeId, executionId: item.executionId }
					}));
				};
				scope.$on('$destroy', function() {
					if (refreshTimer) window.clearTimeout(refreshTimer);
					document.removeEventListener('agent-activity-open', open);
					document.removeEventListener('km-exec-state', scheduleRefresh);
				});
			}
		};
	}
]);
